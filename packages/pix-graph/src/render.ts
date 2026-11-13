/** Rendering for the `graph` tool: call line, live build progress, query trees and results. */

import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { Text, type ToolRenderResultOptions } from "@xynogen/pix-pretty/tui";
import type { RenderContextLike, ThemeLike, ToolResultLike } from "@xynogen/pix-pretty/types";
import {
	BODY_PAD,
	dotJoin,
	expandHint,
	frameToolResult,
	hideCollapsedToolCall,
	pluralize,
	renderDimPreview,
	renderRow,
	renderTitle,
} from "@xynogen/pix-pretty/utils";
import { formatDuration, SPINNER } from "@xynogen/pix-pretty/widget-format";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";
import type { BuildProgress } from "./pipeline.ts";

const BAR_WIDTH = 20;

/** Solid/empty progress bar, e.g. `██████░░░░░░`. */
function progressBar(fraction: number): string {
	const clamped = Math.max(0, Math.min(1, fraction));
	const filled = Math.round(clamped * BAR_WIDTH);
	return `${"\u2588".repeat(filled)}${"\u2591".repeat(BAR_WIDTH - filled)}`;
}

export interface QueryHitRow {
	label: string;
	via?: string;
	where?: string;
	depth: number;
}

export interface GraphResultDetails {
	_type: "graphResult";
	action: "build" | "query" | "impact" | "summarize" | "analyze";
	outcome: "success" | "error" | "running";
	/** Set while a build is in flight, for the progress-bar render. */
	progress?: BuildProgress;
	/** Frame index for the running spinner. */
	spinnerFrame?: number;
	/** Elapsed ms since the build started. */
	elapsedMs?: number;
	/** Structured query result, for the colored hit render. */
	query?: { question: string; traversal: "bfs" | "dfs" | "impact"; hits: QueryHitRow[] };
	impact?: { files: string[]; tests: string[]; dependents: number; truncated: boolean };
	summary?: { modules: { name: string; status: string }[]; remaining: number; total: number };
}

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
function treePrefix(rows: QueryHitRow[], i: number, t: ThemeLike): string {
	const d = rows[i]?.depth ?? 0;
	if (d === 0) return "";
	let guides = "";
	for (let a = 1; a < d; a++) guides += hasSiblingAfter(rows, i, a) ? "│  " : "   ";
	const connector = isLastAtDepth(rows, i) ? "└─ " : "├─ ";
	return t.fg("muted", guides + connector);
}

/** Render query hits as a colored dependency tree with box-drawing connectors. */
function renderQuery(q: NonNullable<GraphResultDetails["query"]>, t: ThemeLike): string {
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
function renderBuildProgress(d: GraphResultDetails, t: ThemeLike): string {
	const p = d.progress;
	if (!p) return t.fg("muted", "building graph…");
	const frame = SPINNER[(d.spinnerFrame ?? 0) % SPINNER.length] ?? SPINNER[0];
	const pct = `${Math.round(Math.max(0, Math.min(1, p.fraction)) * 100)}%`.padStart(4);
	const bar = t.fg("accent", progressBar(p.fraction));
	const stats = dotJoin([p.label, d.elapsedMs != null ? formatDuration(d.elapsedMs, "btw") : ""]);
	return `${t.fg("accent", frame ?? "")} ${t.fg("toolTitle", t.bold("graph"))} ${bar} ${t.fg("toolTitle", pct)}  ${t.fg("muted", stats)}`;
}

/** `packages/<name>/...` → the package; anything else → its top-level folder. */
export const packageOf = (file: string): string => {
	const parts = file.split("/");
	return parts[0] === "packages" && parts[1] ? `packages/${parts[1]}` : (parts[0] ?? file);
};

export function renderGraphCall(args: unknown, theme: ThemeLike, context: RenderContextLike) {
	const t = theme;
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
	const title = renderTitle(t, "graph", context, a.action ?? "build");
	if (a.action === "query") {
		const trav = a.scope === "global" ? "global" : a.dfs ? "dfs" : "bfs";
		const q = a.question ? t.fg("dim", `“${a.question}”`) : "";
		return new Text(`${title} ${q} ${t.fg("muted", `· ${trav}`)}`, 0, 0);
	}
	if (a.action === "impact") {
		const q = a.question ? t.fg("dim", `“${a.question}”`) : "";
		const scope = a.path ? ` ${t.fg("muted", `in ${a.path}`)}` : "";
		return new Text(`${title} ${q}${scope}`, 0, 0);
	}
	if (a.action === "summarize") {
		const target = a.module ? ` ${t.fg("dim", a.module)}` : "";
		return new Text(`${title}${target}`, 0, 0);
	}
	const target = a.path ? t.fg("dim", a.path) : t.fg("dim", ".");
	return new Text(`${title} ${target}`, 0, 0);
}

export function renderGraphResult(
	result: ToolResultLike,
	options: ToolRenderResultOptions,
	theme: ThemeLike,
	context: RenderContextLike,
) {
	const text = result.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
	const details = result.details as GraphResultDetails | undefined;
	const t = theme;
	if (details?.outcome === "running") {
		return new Text(renderBuildProgress(details, t), 0, 0);
	}
	const isError = context.isError || details?.outcome === "error";
	let component: Text;
	if (isError) {
		component = new Text(`${t.fg("error", icon("status.error"))} ${t.fg("error", text)}`, 0, 0);
	} else if (details?.impact || details?.summary) {
		const rows: string[] = [];
		if (details.impact) {
			const info = details.impact;
			// The call row carries the title and question; keep only the counts.
			rows.push(
				`${BODY_PAD}${t.fg("muted", `${pluralize(info.dependents, "dependent")} · ${pluralize(info.files.length, "file")} · ${pluralize(info.tests.length, "test")}`)}`,
			);
			const packages = new Map<string, number>();
			for (const file of info.files)
				packages.set(packageOf(file), (packages.get(packageOf(file)) ?? 0) + 1);
			const groups = [...packages];
			for (const [name, count] of options.expanded ? groups : groups.slice(0, 12))
				rows.push(
					`${BODY_PAD}${t.fg("accent", name)}${t.fg("muted", ` · ${pluralize(count, "file")}`)}`,
				);
			if (!options.expanded && groups.length > 12)
				rows.push(
					`${BODY_PAD}${t.fg("muted", `… ${groups.length - 12} more packages `)}${expandHint(t, context)}`,
				);
			if (!options.expanded && info.tests.length > 6)
				rows.push(
					`${BODY_PAD}${t.fg("muted", `… ${info.tests.length - 6} more tests `)}${expandHint(t, context)}`,
				);
			for (const file of info.tests.slice(0, options.expanded ? info.tests.length : 6))
				rows.push(`${BODY_PAD}${t.fg("muted", "Test · ")}${t.fg("dim", file)}`);
			if (info.truncated)
				rows.push(
					`${BODY_PAD}${t.fg("warning", "Impact truncated; narrow with path before assuming all callers are covered.")}`,
				);
		} else if (details.summary) {
			rows.push(
				`${BODY_PAD}${t.fg("muted", `${details.summary.remaining}/${details.summary.total} missing or stale`)}`,
			);
			for (const module of details.summary.modules)
				rows.push(
					`${BODY_PAD}${t.fg("accent", module.name)}${t.fg(module.status === "stored" ? "success" : "warning", ` · ${module.status}`)}`,
				);
			if (!details.summary.modules.length)
				rows.push(`${BODY_PAD}${t.fg("success", "All summaries are current")}`);
		}
		if (options.expanded)
			rows.push(renderDimPreview(text, t, { maxLines: Number.MAX_SAFE_INTEGER, ctx: context }));
		else rows.push(`${BODY_PAD}${expandHint(t, context)}`);
		component = new Text(rows.join("\n"), 0, 0);
	} else if (details?.query) {
		component = new Text(renderQuery(details.query, t), 0, 0);
	} else if (details?.action === "build") {
		component = new Text(`${t.fg("success", icon("status.done"))} ${text}`, 0, 0);
	} else {
		component = new Text(text, 0, 0);
	}
	if (options.isPartial) return component;
	if (!details) return frameToolResult(component, theme, isError);
	if (tickCollapse("graph", context.state as CollapseState, context.invalidate, context.expanded))
		return new Text(
			renderRow(
				t,
				`graph · ${details.action}`,
				"",
				isError ? "failed" : "done",
				isError ? "error" : "success",
			),
			0,
			0,
		);
	return frameToolResult(component, theme, isError);
}
