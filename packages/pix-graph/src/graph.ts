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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
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
import { createGraphParseCache } from "./parse-cache.ts";
import type { BuildProgress } from "./pipeline.ts";
import { query as queryGraph } from "./query.ts";

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
	action: "build" | "query";
	outcome: "success" | "error" | "running";
	/** Set while a build is in flight, for the progress-bar render. */
	progress?: BuildProgress;
	/** Frame index for the running spinner. */
	spinnerFrame?: number;
	/** Elapsed ms since the build started. */
	elapsedMs?: number;
	/** Structured query result, for the colored hit render. */
	query?: { question: string; traversal: "bfs" | "dfs"; hits: QueryHitRow[] };
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

function loadGraph(cwd: string): GraphData | undefined {
	for (const dir of [OUT_DIR, ...LEGACY_DIRS]) {
		for (const name of ["graph.cleaned.json", "graph.json"]) {
			const path = join(cwd, dir, name);
			if (!existsSync(path)) continue;
			try {
				return JSON.parse(readFileSync(path, "utf8")) as GraphData;
			} catch {
				return undefined;
			}
		}
	}
	return undefined;
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
				"Code knowledge graph (TS/JS). action=build extracts+clusters the codebase into " +
				`${OUT_DIR}/graph.json (also use to update after edits). action=query answers a ` +
				"codebase question by traversing an existing graph — prefer it over grepping for " +
				'"how does X work", "what calls Y", "trace Z".',
			promptSnippet:
				'graph(action, path?, question?, dfs?) — action: build|query. build [path=.] (re)builds the graph; query "<question>" traverses it.',
			promptGuidelines: [
				`For codebase questions, if ${OUT_DIR}/graph.json exists, call graph(action:"query", question) before reading files.`,
				'After changing code, graph(action:"build") refreshes the graph so later queries stay accurate.',
			],
			parameters: Type.Object({
				action: Type.Enum(["build", "query"] as const, {
					type: "string",
					description:
						'"build" (re)builds/updates the graph from source; "query" answers a question from the existing graph.',
				}),
				path: Type.Optional(
					Type.String({ description: "build: directory or file to scan (default: current dir)." }),
				),
				question: Type.Optional(
					Type.String({ description: "query: natural-language question about the codebase." }),
				),
				dfs: Type.Optional(
					Type.Boolean({
						description: "query: depth-first (trace a specific path) instead of breadth-first.",
					}),
				),
			}),

			renderCall(args, theme, context) {
				const t = theme as Theme;
				if (hideCollapsedToolCall(context.state as CollapseState, context.expanded, () => {}))
					return new Text("", 0, 0);
				const a = args as { action?: string; question?: string; path?: string; dfs?: boolean };
				const title = formatToolCallTitle(t, "graph", context);
				if (a.action === "query") {
					const trav = a.dfs ? "dfs" : "bfs";
					const q = a.question ? t.fg("dim", `“${a.question}”`) : "";
					return new Text(`${title} ${t.fg("muted", `query · ${trav}`)} ${q}`, 0, 0);
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

			async execute(_id, params, signal, onUpdate) {
				const action = params.action as "build" | "query";
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
						);
						const took = formatDuration(Date.now() - startedAt, "btw");
						return ok(
							`Graph ${r.cached ? "unchanged (cache hit)" : `built in ${took}`}: ` +
								`${r.files} files → ${r.nodes} nodes, ${r.links} links, ` +
								`${r.communities} communities → ${OUT_DIR}/ (view: /graph)` +
								(r.cached ? "" : ` · parsed ${r.parsedFiles} · reused ${r.reusedFiles}`),
						);
					} catch (error) {
						const msg = getErrorMessage(error);
						return fail(msg === "Operation aborted" ? "Build aborted." : `Build failed: ${msg}`);
					} finally {
						clearInterval(ticker);
					}
				}

				// action === "query"
				const question = (params.question as string | undefined)?.trim();
				if (!question) return fail('query requires a "question".');
				const graph = loadGraph(cwd);
				if (!graph) {
					return fail(
						`No graph found. Run graph(action:"build") first to create ${OUT_DIR}/graph.json.`,
					);
				}
				const traversal = params.dfs ? "dfs" : "bfs";
				const hits = queryGraph(graph, question, { mode: traversal });
				const rows: QueryHitRow[] = hits.map((h) => {
					const row: QueryHitRow = { label: h.node.label ?? h.node.id, depth: h.depth };
					if (h.via) row.via = h.via;
					if (h.node.source_file) row.where = h.node.source_file;
					return row;
				});
				// Plain-text fallback (for non-TUI consumers) mirrors the tree render.
				const plainRows = rows.map((h) => {
					const via = h.via ? ` (via ${h.via})` : "";
					const where = h.where ? ` — ${h.where}` : "";
					return `${"  ".repeat(h.depth)}${h.label}${via}${where}`;
				});
				const text = rows.length === 0 ? "No matching nodes in the graph." : plainRows.join("\n");
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
