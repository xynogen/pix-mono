/**
 * graph.ts — the `graph` tool: build/update a code knowledge graph and query it.
 *
 * Two modes:
 *   build — extract TS/JS with the TypeScript compiler API, cluster into
 *           communities, write .pi/pix-graph/{graph,graph.cleaned}.json +
 *           GRAPH_REPORT.md. Rebuilds from scratch (also serves "update").
 *   query — traverse an existing graph.json to answer a codebase question
 *           (BFS for broad context, DFS to trace a path).
 *
 * The graph JSON is shared with external graphify — either tool's output works
 * with the other's query. Registering this as a real tool costs one recurring
 * schema; kept minimal (single tool, two modes) per the token-budget rule.
 */

import { dirname, join, resolve } from "node:path";
import { grammarConsent } from "@xynogen/pix-pretty/grammar-consent";
import { getErrorMessage } from "@xynogen/pix-pretty/utils";
import { formatDuration } from "@xynogen/pix-pretty/widget-format";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "@xynogen/pix-runtime/fs";
import type { ExtensionAPI } from "@xynogen/pix-runtime/host";
import { once } from "@xynogen/pix-runtime/once";
import { openTarget, runGit } from "@xynogen/pix-runtime/os";
import { ownerRel, projectPath } from "@xynogen/pix-runtime/paths";
import { type Static, Type } from "typebox";
import { type CodeHealth, codeHealth, parseGitLog } from "./analyze.ts";
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
import {
	type GraphResultDetails,
	packageOf,
	type QueryHitRow,
	renderGraphCall,
	renderGraphResult,
} from "./render.ts";

const OUT_DIR = ownerRel("pix-graph");
// Also read graphs left by the CLI's old default / external graphify.
const LEGACY_DIRS = ["graphify-out"];

/** Move a graph from the pre-owner `.pi/graph/` once, so stored summaries survive. */
function migrateGraphDir(cwd: string): void {
	const legacy = projectPath(cwd, "graph");
	const current = resolve(cwd, OUT_DIR);
	if (!existsSync(legacy) || existsSync(current)) return;
	try {
		renameSync(legacy, current);
	} catch {
		// Locked on Windows or a cross-device link: the next build writes the new dir.
	}
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
		impact: {
			files: r.files,
			tests: r.tests,
			dependents: r.hits.length - r.seeds.length,
			truncated: r.truncated,
		},
	};
	return { content: [{ type: "text" as const, text: impactText(r, rows) }], details };
}

/** Commits of history that analyze reads; older ones rarely predict today's risk. */
const HISTORY_COMMITS = 1000;

/** Run action=analyze: graph structure joined with git history. */
async function runAnalyze(
	graph: GraphData,
	cwd: string,
	refreshed: string,
	signal?: AbortSignal,
): Promise<string> {
	// --relative keeps paths relative to cwd, the root graph source_file paths use.
	const args = ["log", "--no-merges", "--relative", "--name-only", "--format=%x00"];
	let log: string | null;
	let why = "not a repo, or git failed";
	try {
		log = await runGit([...args, `-n${HISTORY_COMMITS}`], { cwd, signal, timeoutMs: 15_000 });
	} catch (error) {
		// runGit rethrows only a missing git binary; untested files need no history.
		log = null;
		why = getErrorMessage(error);
	}
	const commits = log ? parseGitLog(log) : [];
	const note = log
		? `Last ${commits.length} commits.`
		: `No git history (${why}): hotspots and coupling skipped.`;
	return `${note}\n\n${healthText(codeHealth(graph, commits))}${refreshed}`;
}

function healthText(h: CodeHealth): string {
	const section = (title: string, rows: string[]) =>
		[title, ...(rows.length ? rows : ["  none"])].join("\n");
	return [
		section(
			"Hotspots (commits × dependent files; change with care):",
			h.hotspots.map((x) => `  ${x.file} — ${x.commits} commits, ${x.dependents} dependents`),
		),
		section(
			"Hidden coupling (change together, no dependency edge):",
			h.coupling.map(
				(c) => `  ${c.a} ↔ ${c.b} — ${c.shared} shared commits (${Math.round(c.ratio * 100)}%)`,
			),
		),
		section(
			"Untested (depended on, no test touches it directly):",
			h.untested.map((u) => `  ${u.file} — ${u.dependents} dependents`),
		),
	].join("\n\n");
}

/** Above this many dependents, the tree shows direct dependents only; deeper ones fold. */
const IMPACT_TREE_MAX = 25;

/**
 * Large impact lists cost tokens per row. Keep seeds and direct dependents as a tree and
 * fold depth 2+ into one row per file with a count. When direct dependents alone exceed the
 * limit, fold them too, per package: the agent still sees every affected area, and the
 * footer still lists every test file.
 */
export function impactRows(rows: QueryHitRow[]): {
	rows: QueryHitRow[];
	folded: string[];
	foldedBy: "file" | "package";
} {
	if (rows.length <= IMPACT_TREE_MAX) return { rows, folded: [], foldedBy: "file" };
	const direct = rows.filter((r) => r.depth <= 1);
	const byPackage = direct.length > IMPACT_TREE_MAX;
	const counts = new Map<string, number>();
	for (const row of rows) {
		if (row.depth === 0 || (!byPackage && row.depth === 1)) continue;
		const where = row.where ?? row.label;
		const key = byPackage ? packageOf(where) : where;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const folded = [...counts]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, n]) => `  ${key} (${n})`);
	return {
		rows: byPackage ? rows.filter((r) => r.depth === 0) : direct,
		folded,
		foldedBy: byPackage ? "package" : "file",
	};
}

/** Tree plus a footer the agent acts on: dependent count, ambiguity, and tests to run. */
function impactText(r: ImpactResult, rows: QueryHitRow[]): string {
	const dependents = r.hits.length - r.seeds.length;
	const { rows: shown, folded, foldedBy } = impactRows(rows);
	const heading =
		foldedBy === "package"
			? "Dependents by package (too many to list; pass path to narrow):"
			: "Indirect dependents (depth 2+), by file:";
	return [
		plain(shown),
		...(folded.length ? ["", heading, ...folded] : []),
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

const GRAPH_TOOL_SPEC = {
	description:
		"Code knowledge graph (TS/JS only). action=build extracts+clusters the codebase into " +
		`${OUT_DIR}/graph.json (also use to update after edits). action=query is a lexical ` +
		"search (not semantic): it matches keywords against symbol/file names, then walks " +
		'their neighbors. Pass identifiers or name fragments ("authenticate token"), not prose. ' +
		'scope:"global" ranks whole modules (packages) with their summary, entry files, APIs and ' +
		"dependencies, for architecture questions. action=impact lists who calls or imports a " +
		"symbol or file (question), transitively, with affected files and tests. action=summarize " +
		"lists modules whose summary is missing or stale with their evidence; call it again with " +
		"module+summary to store one. action=analyze joins the graph with git history: hotspots, " +
		"hidden coupling (co-changed, no dependency) and untested central files.",
	promptSnippet:
		'graph(action, path?, question?, scope?, dfs?, module?, summary?) — build|query|impact|summarize|analyze. query "<keywords>" matches names and traverses; scope:"global" ranks modules for architecture questions; impact "<symbol or file>" lists dependents; analyze finds risky code.',
	promptGuidelines: [
		`To locate TS/JS code, if ${OUT_DIR}/graph.json exists, call graph(action:"query", question:"<identifier keywords>") before reading files. It matches names, not meaning; on no match, fall back to grep.`,
		'Before changing a function, type, or file signature, call graph(action:"impact", question:"<name>") and update every listed caller and test in the same change.',
		'After changing code, graph(action:"build") refreshes the graph so later queries stay accurate.',
	],
	parameters: Type.Object({
		action: Type.Enum(["build", "query", "impact", "summarize", "analyze"] as const, {
			type: "string",
			description:
				'"build" (re)builds the graph; "query" answers from it; "impact" lists dependents of a symbol/file; "summarize" lists or stores module summaries; "analyze" reports hotspots, hidden coupling and untested files.',
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
};

type GraphParams = Static<typeof GRAPH_TOOL_SPEC.parameters>;
type GraphAction = GraphParams["action"];

/** ok/fail builders for one action, so every result carries the same details header. */
function result(action: GraphAction) {
	const details = (outcome: "success" | "error"): GraphResultDetails => ({
		_type: "graphResult",
		action,
		outcome,
	});
	return {
		ok: (text: string, extra: Partial<GraphResultDetails> = {}) => ({
			content: [{ type: "text" as const, text }],
			details: { ...details("success"), ...extra },
		}),
		fail: (text: string) => ({
			content: [{ type: "text" as const, text }],
			details: details("error"),
			isError: true,
		}),
	};
}
type Results = ReturnType<typeof result>;

/** Run action=build with a live spinner, and report what the pipeline did. */
async function runBuild(
	r: Results,
	cwd: string,
	path: string | undefined,
	parseCache: GraphParseCache,
	emit: (details: GraphResultDetails) => void,
	signal: AbortSignal | undefined,
	ctx: Parameters<typeof grammarConsent>[0],
) {
	// ponytail: pipeline pulls in typescript (9.1 MB, about 224 ms). Load it only when a build runs.
	const { buildCodeGraphProgress } = await import("./pipeline.ts");
	const consent = grammarConsent(ctx, signal);
	const startedAt = Date.now();
	let frame = 0;
	let last: BuildProgress | undefined;
	const tick = (): void => {
		if (!last) return;
		emit({
			_type: "graphResult",
			action: "build",
			outcome: "running",
			progress: last,
			spinnerFrame: frame++,
			elapsedMs: Date.now() - startedAt,
		});
	};
	// Animate the spinner + elapsed clock even between phase updates.
	const ticker = setInterval(tick, 120);
	try {
		const b = await buildCodeGraphProgress(
			path?.trim() || ".",
			cwd,
			resolve(cwd, OUT_DIR),
			(progress) => {
				last = progress;
				tick();
			},
			signal,
			parseCache,
			consent,
		);
		const took = formatDuration(Date.now() - startedAt, "btw");
		const langs = Object.entries(b.languages ?? {})
			.map(([lang, n]) => `${lang} ${n}`)
			.join(", ");
		return r.ok(
			`Graph ${b.cached ? "unchanged (cache hit)" : `built in ${took}`}: ` +
				`${b.files} files → ${b.nodes} nodes, ${b.links} links, ` +
				`${b.communities} communities → ${OUT_DIR}/ (view: /graph)` +
				(b.cached ? "" : ` · parsed ${b.parsedFiles} · reused ${b.reusedFiles}`) +
				(langs ? `\nOther languages (ast-grep): ${langs}` : "") +
				(b.skipped?.length ? `\nSkipped: ${b.skipped.join("; ")}` : ""),
		);
	} catch (error) {
		const msg = getErrorMessage(error);
		return r.fail(msg === "Operation aborted" ? "Build aborted." : `Build failed: ${msg}`);
	} finally {
		clearInterval(ticker);
	}
}

/** Run action=summarize: store one summary, or list a bounded batch of stale modules. */
function runSummarize(
	r: Results,
	graph: GraphData,
	summariesPath: string,
	params: Pick<GraphParams, "module" | "summary">,
	model: string,
) {
	const cards = moduleCards(graph);
	const stored = loadSummaries(summariesPath);
	const name = params.module?.trim();
	const text = params.summary;
	if (name || text !== undefined) {
		if (!name || text === undefined) return r.fail("summarize needs both module and summary.");
		const card = cards.find((c) => c.module === name);
		if (!card) return r.fail(`Unknown module: ${name}.`);
		// The summary was written by the session model; stamp it so provenance stays visible.
		const saved = storeSummary(summariesPath, card, text, model);
		if (typeof saved === "string") return r.fail(`Summary rejected: ${saved}`);
		const left = staleCards(cards, loadSummaries(summariesPath)).length;
		return r.ok(
			`Stored summary for ${card.module} (model ${model}, evidence ${card.hash}) → ${OUT_DIR}/summaries.json. ${left} module(s) still missing or stale.`,
			{
				summary: {
					modules: [{ name: card.module, status: "stored" }],
					remaining: left,
					total: cards.length,
				},
			},
		);
	}
	const stale = staleCards(cards, stored);
	if (stale.length === 0) {
		return r.ok(`All ${cards.length} module summaries are current. Nothing to write.`, {
			summary: { modules: [], remaining: 0, total: cards.length },
		});
	}
	// Bounded work list: the agent summarizes a few modules per call and comes back.
	const batch = stale.slice(0, 5);
	const tokens = batch.reduce((n, c) => n + estimateTokens(c.text), 0);
	return r.ok(
		[
			`${stale.length} of ${cards.length} module summaries missing or stale. Showing ${batch.length} evidence card(s), ~${tokens} tokens.`,
			`For each, call graph(action:"summarize", module, summary) with 2-5 sentences grounded only in its card.`,
			...batch.map((c) => `\n${c.text}`),
		].join("\n"),
		{
			summary: {
				modules: batch.map((card) => ({
					name: card.module,
					status: stored.modules[card.module] ? "stale" : "missing",
				})),
				remaining: stale.length,
				total: cards.length,
			},
		},
	);
}

/** Run action=query: rank modules (scope global) or walk symbols (local). */
function runQuery(
	r: Results,
	graph: GraphData,
	summariesPath: string,
	params: Pick<GraphParams, "question" | "scope" | "dfs">,
	refreshed: string,
) {
	const question = params.question?.trim();
	if (!question) return r.fail('query requires a "question".');
	const keywords = tokenize(question).join(", ") || "(no keywords)";
	if (params.scope === "global") {
		const cards = moduleCards(graph);
		const hits = globalQuery(cards, loadSummaries(summariesPath), question);
		if (hits.length === 0)
			return r.ok(`No module matches: ${keywords}. ${cards.length} modules in the graph.`);
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
		return r.ok(`${blocks.join("\n\n")}${hint}`);
	}
	const traversal = params.dfs ? "dfs" : "bfs";
	const rows = toRows(queryGraph(graph, question, { mode: traversal }));
	const text =
		rows.length === 0
			? `No graph node name matches: ${keywords}. Query is lexical over TS/JS symbol/file names; retry with identifiers or use grep.`
			: plain(rows) + refreshed;
	return r.ok(text, { query: { question, traversal, hits: rows } });
}

export default function registerGraph(pi: ExtensionAPI): void {
	once(pi, "pix-graph", () => {
		const cwd = process.cwd();
		migrateGraphDir(cwd);
		const parseCache = createGraphParseCache();
		let cacheTimer: ReturnType<typeof setTimeout> | undefined;
		let activeCalls = 0;
		const releaseIdleCache = () => {
			if (activeCalls === 0) parseCache.entries.clear();
		};

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
						// A legacy graphify-out graph has no output dir yet.
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
			...GRAPH_TOOL_SPEC,
			renderCall: renderGraphCall,
			renderResult: renderGraphResult,

			async execute(_id, params, signal, onUpdate, ctx) {
				clearTimeout(cacheTimer);
				activeCalls++;
				try {
					const r = result(params.action);
					if (params.action === "build") {
						const emit = (details: GraphResultDetails) =>
							onUpdate?.({
								content: [{ type: "text" as const, text: details.progress?.label ?? "" }],
								details,
							});
						return await runBuild(r, cwd, params.path, parseCache, emit, signal, ctx);
					}

					const { graph, refreshed } = await loadFresh(
						cwd,
						params.action === "summarize",
						parseCache,
						signal,
					);
					if (!graph) {
						return r.fail(
							`No graph found. Run graph(action:"build") first to create ${OUT_DIR}/graph.json.`,
						);
					}
					const summariesPath = join(cwd, OUT_DIR, "summaries.json");
					switch (params.action) {
						case "summarize": {
							const model = ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
							return runSummarize(r, graph, summariesPath, params, model);
						}
						case "analyze":
							return r.ok(await runAnalyze(graph, cwd, refreshed, signal));
						case "impact": {
							const out = runImpact(graph, params.question, params.path);
							if (typeof out === "string") return r.fail(out);
							out.content[0] = { type: "text", text: `${out.content[0]?.text}${refreshed}` };
							return out;
						}
						default:
							return runQuery(r, graph, summariesPath, params, refreshed);
					}
				} finally {
					activeCalls--;
					clearTimeout(cacheTimer);
					// ponytail: retain ASTs for 30s between calls; cold builds reparse, disk results stay cached.
					cacheTimer = setTimeout(releaseIdleCache, 30_000);
					cacheTimer.unref();
				}
			},
		});
	});
}
