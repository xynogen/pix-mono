/**
 * graph.ts — the `graph` tool: build/update a code knowledge graph and query it.
 *
 * Two modes:
 *   build — extract TS/JS with the TypeScript compiler API, cluster into
 *           communities, write graphify-out/{graph,graph.cleaned}.json +
 *           GRAPH_REPORT.md. Rebuilds from scratch (also serves "update").
 *   query — traverse an existing graph.json to answer a codebase question
 *           (BFS for broad context, DFS to trace a path).
 *
 * The graph JSON is shared with external graphify — either tool's output works
 * with the other's query. Registering this as a real tool costs one recurring
 * schema; kept minimal (single tool, two modes) per the token-budget rule.
 */

import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { grammarConsent } from "@xynogen/pix-pretty/grammar-consent";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import {
	dotJoin,
	formatCollapsedToolRow,
	formatToolCallTitle,
	frameToolResult,
	getErrorMessage,
	hideCollapsedToolCall,
} from "@xynogen/pix-pretty/utils";
import { formatDuration, SPINNER } from "@xynogen/pix-pretty/widget-format";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";
import { once } from "@xynogen/pix-runtime/once";
import { openTarget } from "@xynogen/pix-runtime/os";
import { projectDir } from "@xynogen/pix-runtime/paths";
import { Type } from "typebox";
import type { GraphData } from "./analyzer.ts";
import { renderGraphHtml } from "./html.ts";
import {
	estimateTokens,
	globalQuery,
	loadSummaries,
	moduleCards,
	staleCards,
	storeSummary,
} from "./modules.ts";
import { createGraphParseCache, type GraphParseCache } from "./parse-cache.ts";
import type { BuildProgress } from "./pipeline.ts";
import {
	type ImpactResult,
	impact,
	type QueryHit,
	query as queryGraph,
	tokenize,
} from "./query.ts";

const OUT_DIR = `${projectDir()}/graph`; // "/" so prompt text reads the same on Windows
// Also read graphs left by the CLI's old default / external graphify.
const LEGACY_DIRS = ["graphify-out"];
const BAR_WIDTH = 20;

/** Solid/empty progress bar, e.g. `██████░░░░░░`. */
function progressBar(fraction: number): string {
	const clamped = Math.max(0, Math.min(1, fraction));
	const filled = Math.round(clamped * BAR_WIDTH);
	return `${"\u2588".repeat(filled)}${"\u2591".repeat(BAR_WIDTH - filled)}`;
}

interface QueryHitRow {
	label: string;
	via?: string;
	where?: string;
	depth: number;
}

interface GraphResultDetails {
	_type: "graphResult";
	action: "build" | "query" | "impact" | "summarize";
	outcome: "success" | "error" | "running";
	/** Set while a build is in flight, for the progress-bar render. */
	progress?: BuildProgress;
	/** Frame index for the running spinner. */
	spinnerFrame?: number;
	/** Elapsed ms since the build started. */
	elapsedMs?: number;
	/** Structured query result, for the colored hit render. */
	query?: { question: string; traversal: "bfs" | "dfs" | "impact"; hits: QueryHitRow[] };
}

type Theme = {
	fg: (role: string, s: string) => string;
	bold: (s: string) => string;
};

/**
 * Is `rows[i]` the last node at its own depth within its parent branch?
 * True when the next shallower-or-equal row is strictly shallower (or absent).
 */
function isLastAtDepth(rows: QueryHitRow[], i: number): boolean {
	const d = rows[i]?.depth ?? 0;
	for (let j = i + 1; j < rows.length; j++) {
		const dj = rows[j]?.depth ?? 0;
		if (dj < d) return true;
		if (dj === d) return false;
	}
	return true;
}

/** Does a sibling continue at ancestor depth `a` somewhere after row `i`? */
function hasSiblingAfter(rows: QueryHitRow[], i: number, a: number): boolean {
	for (let j = i + 1; j < rows.length; j++) {
		const dj = rows[j]?.depth ?? 0;
		if (dj < a) return false;
		if (dj === a) return true;
	}
	return false;
}

/** Box-drawing prefix for a flat depth-ordered node list, e.g. `│  ├─ `. */
function treePrefix(rows: QueryHitRow[], i: number, t: Theme): string {
	const d = rows[i]?.depth ?? 0;
	if (d === 0) return "";
	let guides = "";
	for (let a = 1; a < d; a++) guides += hasSiblingAfter(rows, i, a) ? "│  " : "   ";
	const connector = isLastAtDepth(rows, i) ? "└─ " : "├─ ";
	return t.fg("muted", guides + connector);
}

/** Render query hits as a colored dependency tree with box-drawing connectors. */
function renderQuery(q: NonNullable<GraphResultDetails["query"]>, t: Theme): string {
	// The question is already shown on the tool-call line (renderCall); the result
	// header carries only the traversal + node count so it isn't echoed twice.
	const header = t.fg(
		"muted",
		`${q.traversal} · ${q.hits.length} ${q.hits.length === 1 ? "node" : "nodes"}`,
	);
	if (q.hits.length === 0) return `${header}\n  ${t.fg("muted", "no matching nodes")}`;
	const rows = q.hits.map((h, i) => {
		const prefix = treePrefix(q.hits, i, t);
		// Seeds (depth 0) pop in accent; traversed nodes in toolTitle.
		const label = t.fg(h.depth === 0 ? "accent" : "toolTitle", h.label);
		const via = h.via ? ` ${t.fg("muted", `(${h.via})`)}` : "";
		const where = h.where ? `  ${t.fg("muted", h.where)}` : "";
		return `  ${prefix}${label}${via}${where}`;
	});
	return [header, ...rows].join("\n");
}

/** One-line live build widget: spinner + bar + percent + phase + stats. */
function renderBuildProgress(d: GraphResultDetails, t: Theme): string {
	const p = d.progress;
	if (!p) return t.fg("muted", "building graph…");
	const frame = SPINNER[(d.spinnerFrame ?? 0) % SPINNER.length] ?? SPINNER[0];
	const pct = `${Math.round(Math.max(0, Math.min(1, p.fraction)) * 100)}%`.padStart(4);
	const bar = t.fg("accent", progressBar(p.fraction));
	const stats = dotJoin([p.label, d.elapsedMs != null ? formatDuration(d.elapsedMs, "btw") : ""]);
	return `${t.fg("accent", frame ?? "")} ${t.fg("toolTitle", t.bold("graph"))} ${bar} ${t.fg("toolTitle", pct)}  ${t.fg("muted", stats)}`;
}

function loadGraph(cwd: string): (GraphData & { builtMs: number }) | undefined {
	for (const dir of [OUT_DIR, ...LEGACY_DIRS]) {
		for (const name of ["graph.cleaned.json", "graph.json"]) {
			const path = join(cwd, dir, name);
			if (!existsSync(path)) continue;
			try {
				const graph = JSON.parse(readFileSync(path, "utf8")) as GraphData;
				return { ...graph, builtMs: statSync(path).mtimeMs };
			} catch {
				return undefined;
			}
		}
	}
	return undefined;
}

/**
 * Graph source files changed after the build (one stat each). New files are not seen;
 * they show up after the next build. A deleted or moved file counts as changed.
 */
export function staleCount(graph: GraphData, builtMs: number, cwd: string): number {
	const files = new Set(graph.nodes.flatMap((n) => (n.source_file ? [n.source_file] : [])));
	let changed = 0;
	for (const rel of files) {
		try {
			if (statSync(join(cwd, rel)).mtimeMs > builtMs) changed++;
		} catch {
			changed++;
		}
	}
	return changed;
}

/**
 * Rebuild a stale graph before answering. Scope is the repo root, the default build input.
 * A failed rebuild keeps the old graph and says it is stale, so the answer is never silent.
 */
async function refreshGraph(
	cwd: string,
	changed: number,
	parseCache: GraphParseCache,
	signal?: AbortSignal,
): Promise<string> {
	const startedAt = Date.now();
	try {
		const { buildCodeGraphProgress } = await import("./pipeline.ts");
		// ponytail: rebuilds "."; a graph built from a subfolder widens to the whole repo here.
		await buildCodeGraphProgress(".", cwd, resolve(cwd, OUT_DIR), () => {}, signal, parseCache);
		// A content-identical rebuild is a cache hit that does not rewrite the outputs; touch them
		// so an mtime-only change does not trigger a rebuild on every call.
		const now = new Date();
		for (const name of ["graph.json", "graph.cleaned.json"]) {
			const path = join(cwd, OUT_DIR, name);
			if (existsSync(path)) utimesSync(path, now, now);
		}
		return `\n\nGraph rebuilt first: ${changed} file(s) changed since the last build (${formatDuration(Date.now() - startedAt, "btw")}).`;
	} catch (error) {
		return `\n\nGraph is stale: ${changed} file(s) changed since the build, and the rebuild failed (${getErrorMessage(error)}). Run graph(action:"build") before trusting this.`;
	}
}

/**
 * Load the graph; for query/impact, rebuild it first when sources changed. query/impact on
 * old code can miss a new caller, and a cached rebuild takes about 2 s, so refresh and say
 * so instead of telling the model to do it.
 */
async function loadFresh(
	cwd: string,
	skipRefresh: boolean,
	parseCache: GraphParseCache,
	signal?: AbortSignal,
): Promise<{ graph: ReturnType<typeof loadGraph>; refreshed: string }> {
	const graph = loadGraph(cwd);
	const changed = graph && !skipRefresh ? staleCount(graph, graph.builtMs, cwd) : 0;
	if (!graph || changed === 0) return { graph, refreshed: "" };
	const refreshed = await refreshGraph(cwd, changed, parseCache, signal);
	return { graph: loadGraph(cwd) ?? graph, refreshed };
}

/** Above this many same-named seeds, impact asks for `path` instead of printing every tree. */
const MAX_IMPACT_SEEDS = 5;

/** Run action=impact. Returns an error string, or the tool result. */
function runImpact(graph: GraphData, question?: string, inFile?: string) {
	const target = question?.trim();
	if (!target) return 'impact requires a "question" naming a symbol or file.';
	const r = impact(graph, target, { inFile });
	if (r.seeds.length === 0) {
		return `No node named "${target}"${inFile ? ` in ${inFile}` : ""}. impact needs an exact symbol name, node id, or file path; use graph(action:"query") to find it.`;
	}
	if (r.seeds.length > MAX_IMPACT_SEEDS) {
		const where = r.seeds.map((s) => `  ${s.source_file ?? s.id} (${s.label ?? s.id})`);
		const more = where.length > 5 ? [`  … +${where.length - 5} more`] : [];
		return [
			`"${target}" matches ${r.seeds.length} nodes. Pass path (a file fragment) to pick one:`,
			...where.slice(0, 5),
			...more,
		].join("\n");
	}
	const rows = toRows(r.hits);
	const details: GraphResultDetails = {
		_type: "graphResult",
		action: "impact",
		outcome: "success",
		query: { question: target, traversal: "impact", hits: rows },
	};
	return { content: [{ type: "text" as const, text: impactText(r, rows) }], details };
}

/** Above this many dependents, the tree shows direct dependents only; deeper ones group by file. */
const IMPACT_TREE_MAX = 25;

/**
 * Large impact lists cost tokens per row. Keep seeds and direct dependents as a tree and
 * fold depth 2+ into one row per file with a count: the agent still sees every affected
 * file, and the footer still lists the tests.
 */
export function impactRows(rows: QueryHitRow[]): { rows: QueryHitRow[]; folded: string[] } {
	if (rows.length <= IMPACT_TREE_MAX) return { rows, folded: [] };
	const deep = new Map<string, number>();
	for (const row of rows) {
		if (row.depth > 1)
			deep.set(row.where ?? row.label, (deep.get(row.where ?? row.label) ?? 0) + 1);
	}
	const folded = [...deep].sort(([a], [b]) => a.localeCompare(b)).map(([f, n]) => `  ${f} (${n})`);
	return { rows: rows.filter((r) => r.depth <= 1), folded };
}

/** Tree plus a footer the agent acts on: dependent count, ambiguity, and tests to run. */
function impactText(r: ImpactResult, rows: QueryHitRow[]): string {
	const dependents = r.hits.length - r.seeds.length;
	const { rows: shown, folded } = impactRows(rows);
	return [
		plain(shown),
		...(folded.length ? ["", "Indirect dependents (depth 2+), by file:", ...folded] : []),
		"",
		`${dependents} dependent(s) in ${r.files.length} file(s)${r.truncated ? " (truncated; narrow with path)" : ""}.`,
		...(r.seeds.length > 1
			? [`${r.seeds.length} nodes share this name; pass path to pick one.`]
			: []),
		r.tests.length ? `Tests: ${r.tests.join(", ")}` : "Tests: none reach it.",
	].join("\n");
}

function toRows(hits: QueryHit[]): QueryHitRow[] {
	return hits.map((h) => {
		const row: QueryHitRow = { label: h.node.label ?? h.node.id, depth: h.depth };
		if (h.via) row.via = h.via;
		if (h.node.source_file) row.where = h.node.source_file;
		return row;
	});
}

/** Plain-text fallback (for non-TUI consumers) that mirrors the tree render. */
function plain(rows: QueryHitRow[]): string {
	return rows
		.map((h) => {
			const via = h.via ? ` (via ${h.via})` : "";
			const where = h.where ? ` — ${h.where}` : "";
			return `${"  ".repeat(h.depth)}${h.label}${via}${where}`;
		})
		.join("\n");
}

export default function registerGraph(pi: ExtensionAPI): void {
	once(pi, "pix-graph", () => {
		const cwd = process.cwd();
		const parseCache = createGraphParseCache();

		pi.registerCommand("graph", {
			description: "Open the code graph (graph.html) in the browser",
			handler: async (_args, ctx) => {
				const html = join(cwd, OUT_DIR, "graph.html");
				try {
					// A graph from an older build or from graphify has no HTML yet. Render it from the JSON.
					if (!existsSync(html)) {
						const graph = loadGraph(cwd);
						if (!graph) {
							ctx.ui.notify('No graph yet. Ask the agent to run graph(action:"build").', "warning");
							return;
						}
						// A legacy graphify-out graph has no .pi/graph/ dir yet.
						mkdirSync(dirname(html), { recursive: true });
						writeFileSync(html, renderGraphHtml(graph));
					}
					await openTarget(html);
					ctx.ui.notify(`Opened ${OUT_DIR}/graph.html`, "info");
				} catch (error) {
					ctx.ui.notify(`Cannot open graph: ${getErrorMessage(error)}`, "error");
				}
			},
		});

		pi.registerTool({
			name: "graph",
			label: "Graph",
			renderShell: "self",
			description:
				"Code knowledge graph (TS/JS only). action=build extracts+clusters the codebase into " +
				`${OUT_DIR}/graph.json (also use to update after edits). action=query is a lexical ` +
				"search (not semantic): it matches keywords against symbol/file names, then walks " +
				'their neighbors. Pass identifiers or name fragments ("authenticate token"), not prose. ' +
				'scope:"global" ranks whole modules (packages) with their summary, entry files, APIs and ' +
				"dependencies, for architecture questions. action=impact lists who calls or imports a " +
				"symbol or file (question), transitively, with affected files and tests. " +
				"action=summarize lists modules whose summary " +
				"is missing or stale with their evidence; call it again with module+summary to store one.",
			promptSnippet:
				'graph(action, path?, question?, scope?, dfs?, module?, summary?) — build|query|impact|summarize. query "<keywords>" matches names and traverses; scope:"global" ranks modules for architecture questions; impact "<symbol or file>" lists dependents.',
			promptGuidelines: [
				`To locate TS/JS code, if ${OUT_DIR}/graph.json exists, call graph(action:"query", question:"<identifier keywords>") before reading files. It matches names, not meaning; on no match, fall back to grep.`,
				'Before changing a function, type, or file signature, call graph(action:"impact", question:"<name>") and update every listed caller and test in the same change.',
				'After changing code, graph(action:"build") refreshes the graph so later queries stay accurate.',
			],
			parameters: Type.Object({
				action: Type.Enum(["build", "query", "impact", "summarize"] as const, {
					type: "string",
					description:
						'"build" (re)builds the graph; "query" answers from it; "impact" lists dependents of a symbol/file; "summarize" lists or stores module summaries.',
				}),
				path: Type.Optional(
					Type.String({
						description:
							"build: directory or file to scan (default: current dir). impact: path fragment that narrows an ambiguous name.",
					}),
				),
				question: Type.Optional(
					Type.String({
						description:
							"query: keywords matched against symbol/file names (e.g. 'exportStl mesh'). impact: exact symbol name, node id, or file path.",
					}),
				),
				scope: Type.Optional(
					Type.Enum(["local", "global"] as const, {
						type: "string",
						description:
							'query: "local" (default) walks symbols; "global" ranks modules for architecture questions.',
					}),
				),
				dfs: Type.Optional(
					Type.Boolean({
						description: "query: depth-first (trace a specific path) instead of breadth-first.",
					}),
				),
				module: Type.Optional(
					Type.String({ description: "summarize: module name to store a summary for." }),
				),
				summary: Type.Optional(
					Type.String({
						description:
							"summarize: 2-5 sentences grounded in the module's evidence card (purpose, entry points, key APIs, dependencies).",
					}),
				),
			}),

			renderCall(args, theme, context) {
				const t = theme as Theme;
				if (hideCollapsedToolCall(context.state as CollapseState, context.expanded, () => {}))
					return new Text("", 0, 0);
				const a = args as {
					action?: string;
					question?: string;
					path?: string;
					dfs?: boolean;
					scope?: string;
					module?: string;
				};
				const title = formatToolCallTitle(t, "graph", context);
				if (a.action === "query") {
					const trav = a.scope === "global" ? "global" : a.dfs ? "dfs" : "bfs";
					const q = a.question ? t.fg("dim", `“${a.question}”`) : "";
					return new Text(`${title} ${t.fg("muted", `query · ${trav}`)} ${q}`, 0, 0);
				}
				if (a.action === "impact") {
					const q = a.question ? t.fg("dim", `“${a.question}”`) : "";
					const scope = a.path ? ` ${t.fg("muted", `in ${a.path}`)}` : "";
					return new Text(`${title} ${t.fg("muted", "impact")} ${q}${scope}`, 0, 0);
				}
				if (a.action === "summarize") {
					const target = a.module ? ` ${t.fg("dim", a.module)}` : "";
					return new Text(`${title} ${t.fg("dim", "summarize")}${target}`, 0, 0);
				}
				const target = a.path ? t.fg("dim", a.path) : t.fg("dim", ".");
				return new Text(`${title} ${t.fg("dim", "build")} ${target}`, 0, 0);
			},

			renderResult(result, options, theme, context) {
				const text = result.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
				const details = result.details as GraphResultDetails | undefined;
				const t = theme as Theme;
				if (details?.outcome === "running") {
					return new Text(renderBuildProgress(details, t), 0, 0);
				}
				const isError = context.isError || details?.outcome === "error";
				let component: Text;
				if (isError) {
					component = new Text(
						`${t.fg("error", icon("status.error"))} ${t.fg("error", text)}`,
						0,
						0,
					);
				} else if (details?.query) {
					component = new Text(renderQuery(details.query, t), 0, 0);
				} else if (details?.action === "build") {
					component = new Text(`${t.fg("success", icon("status.done"))} ${text}`, 0, 0);
				} else {
					component = new Text(text, 0, 0);
				}
				if (options.isPartial) return component;
				if (!details) return frameToolResult(component, theme, isError);
				if (
					tickCollapse(
						"graph",
						context.state as CollapseState,
						context.invalidate,
						context.expanded,
					)
				)
					return new Text(
						formatCollapsedToolRow(
							t,
							"graph",
							details.action,
							isError ? "failed" : "done",
							isError ? "error" : "success",
						),
						0,
						0,
					);
				return frameToolResult(component, theme, isError);
			},

			async execute(_id, params, signal, onUpdate, ctx) {
				const action = params.action as "build" | "query" | "impact" | "summarize";
				const details = (outcome: "success" | "error"): GraphResultDetails => ({
					_type: "graphResult",
					action,
					outcome,
				});
				const ok = (text: string) => ({
					content: [{ type: "text" as const, text }],
					details: details("success"),
				});
				const fail = (text: string) => ({
					content: [{ type: "text" as const, text }],
					details: details("error"),
					isError: true,
				});

				if (action === "build") {
					// ponytail: pipeline pulls in typescript (9.1 MB, about 224 ms). Load it only when a build runs.
					const { buildCodeGraphProgress } = await import("./pipeline.ts");
					const consent = grammarConsent(ctx);
					const input = (params.path as string | undefined)?.trim() || ".";
					const startedAt = Date.now();
					let frame = 0;
					let last: BuildProgress | undefined;
					const emit = (): void => {
						if (!last) return;
						onUpdate?.({
							content: [{ type: "text" as const, text: last.label }],
							details: {
								_type: "graphResult",
								action,
								outcome: "running",
								progress: last,
								spinnerFrame: frame++,
								elapsedMs: Date.now() - startedAt,
							},
						});
					};
					// Animate the spinner + elapsed clock even between phase updates.
					const ticker = setInterval(emit, 120);
					try {
						const r = await buildCodeGraphProgress(
							input,
							cwd,
							resolve(cwd, OUT_DIR),
							(progress) => {
								last = progress;
								emit();
							},
							signal,
							parseCache,
							consent,
						);
						const took = formatDuration(Date.now() - startedAt, "btw");
						const langs = Object.entries(r.languages ?? {})
							.map(([lang, n]) => `${lang} ${n}`)
							.join(", ");
						return ok(
							`Graph ${r.cached ? "unchanged (cache hit)" : `built in ${took}`}: ` +
								`${r.files} files → ${r.nodes} nodes, ${r.links} links, ` +
								`${r.communities} communities → ${OUT_DIR}/ (view: /graph)` +
								(r.cached ? "" : ` · parsed ${r.parsedFiles} · reused ${r.reusedFiles}`) +
								(langs ? `\nOther languages (ast-grep): ${langs}` : "") +
								(r.skipped?.length ? `\nSkipped: ${r.skipped.join("; ")}` : ""),
						);
					} catch (error) {
						const msg = getErrorMessage(error);
						return fail(msg === "Operation aborted" ? "Build aborted." : `Build failed: ${msg}`);
					} finally {
						clearInterval(ticker);
					}
				}

				const { graph, refreshed } = await loadFresh(
					cwd,
					action === "summarize",
					parseCache,
					signal,
				);
				if (!graph) {
					return fail(
						`No graph found. Run graph(action:"build") first to create ${OUT_DIR}/graph.json.`,
					);
				}
				const summariesPath = join(cwd, OUT_DIR, "summaries.json");

				if (action === "summarize") {
					const cards = moduleCards(graph);
					const stored = loadSummaries(summariesPath);
					const name = (params.module as string | undefined)?.trim();
					const text = params.summary as string | undefined;
					if (name || text !== undefined) {
						if (!name || text === undefined)
							return fail("summarize needs both module and summary.");
						const card = cards.find((c) => c.module === name);
						if (!card) return fail(`Unknown module: ${name}.`);
						// The summary was written by the session model; stamp it so provenance stays visible.
						const model = ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
						const saved = storeSummary(summariesPath, card, text, model);
						if (typeof saved === "string") return fail(`Summary rejected: ${saved}`);
						const left = staleCards(cards, loadSummaries(summariesPath)).length;
						return ok(
							`Stored summary for ${card.module} (model ${model}, evidence ${card.hash}) → ${OUT_DIR}/summaries.json. ${left} module(s) still missing or stale.`,
						);
					}
					const stale = staleCards(cards, stored);
					if (stale.length === 0) {
						return ok(`All ${cards.length} module summaries are current. Nothing to write.`);
					}
					// Bounded work list: the agent summarizes a few modules per call and comes back.
					const batch = stale.slice(0, 5);
					const tokens = batch.reduce((n, c) => n + estimateTokens(c.text), 0);
					return ok(
						[
							`${stale.length} of ${cards.length} module summaries missing or stale. Showing ${batch.length} evidence card(s), ~${tokens} tokens.`,
							`For each, call graph(action:"summarize", module, summary) with 2-5 sentences grounded only in its card.`,
							...batch.map((c) => `\n${c.text}`),
						].join("\n"),
					);
				}

				if (action === "impact") {
					const out = runImpact(
						graph,
						params.question as string | undefined,
						params.path as string | undefined,
					);
					if (typeof out === "string") return fail(out);
					if (refreshed)
						out.content[0] = { type: "text", text: `${out.content[0]?.text}${refreshed}` };
					return out;
				}

				// action === "query"
				const question = (params.question as string | undefined)?.trim();
				if (!question) return fail('query requires a "question".');
				if (params.scope === "global") {
					const cards = moduleCards(graph);
					const hits = globalQuery(cards, loadSummaries(summariesPath), question);
					if (hits.length === 0) {
						return ok(
							`No module matches: ${tokenize(question).join(", ") || "(no keywords)"}. ${cards.length} modules in the graph.`,
						);
					}
					const missing = hits.filter((h) => h.stale).length;
					const blocks = hits.map((h) => {
						const said = h.summary
							? `summary${h.stale ? " (stale)" : ""} [${h.summary.model}]: ${h.summary.summary}`
							: "summary: none";
						return `${said}\n${h.card.text}`;
					});
					const hint =
						missing > 0
							? `\n\n${missing} module(s) above lack a current summary. graph(action:"summarize") lists them.`
							: "";
					return ok(`${blocks.join("\n\n")}${hint}`);
				}
				const traversal = params.dfs ? "dfs" : "bfs";
				const hits = queryGraph(graph, question, { mode: traversal });
				const rows = toRows(hits);
				const plainRows = plain(rows);
				const text =
					rows.length === 0
						? `No graph node name matches: ${tokenize(question).join(", ") || "(no keywords)"}. Query is lexical over TS/JS symbol/file names; retry with identifiers or use grep.`
						: plainRows + refreshed;
				return {
					content: [{ type: "text" as const, text }],
					details: {
						_type: "graphResult" as const,
						action,
						outcome: "success" as const,
						query: { question, traversal, hits: rows },
					},
				};
			},
		});
	});
}
