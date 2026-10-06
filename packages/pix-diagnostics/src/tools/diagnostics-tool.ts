/**
 * diagnostics-tool.ts — the `lens_diagnostics` tool.
 *
 * Two sources:
 *  - `session` returns cached store snapshots (all, or filtered by `paths`),
 *  - `lsp` runs a fresh check via the manager on 1..100 explicit paths.
 *
 * Findings format one per line, sorted, capped at 500 rows and the host byte
 * limit. Validation and execution errors throw so Pi marks the result failed.
 */

import { resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import {
	formatCollapsedToolRow,
	formatToolCallTitle,
	frameToolResult,
	hideCollapsedToolCall,
} from "@xynogen/pix-pretty/utils";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";
import { Type } from "typebox";
import type { DiagnosticRequest, LspManager } from "../lsp/manager.ts";
import type { DiagnosticStore } from "../store.ts";
import type { DiagnosticSnapshot, PixDiagnostic } from "../types.ts";

const MAX_FINDINGS = 500;
const SEVERITY_RANK: Record<PixDiagnostic["severity"], number> = {
	error: 0,
	warning: 1,
	information: 2,
	hint: 3,
};

export interface DiagnosticsToolDeps {
	store: DiagnosticStore;
	manager: LspManager;
	cwd: string;
}

interface DiagnosticsDetails {
	_type: "pixDiagnostics";
	outcome: "success" | "error" | "partial";
	files: number;
	findings: number;
	unconfirmed: number;
	unavailable: number;
	truncated: boolean;
}

type Severity = PixDiagnostic["severity"] | "all";

function relativePath(cwd: string, filePath: string): string {
	const base = resolve(cwd);
	const abs = resolve(filePath);
	return abs.startsWith(`${base}/`) ? abs.slice(base.length + 1) : abs;
}

function formatFinding(cwd: string, d: PixDiagnostic): string {
	const code = d.code !== undefined ? ` ${d.source ?? "lsp"}(${d.code})` : "";
	return `${relativePath(cwd, d.filePath)}:${d.line}:${d.column} ${d.severity}${code} ${d.message}`;
}

export function collectFindings(
	cwd: string,
	snapshots: DiagnosticSnapshot[],
	severity: Severity,
): string[] {
	const rows: PixDiagnostic[] = [];
	for (const snap of snapshots) {
		for (const d of snap.diagnostics) {
			if (severity !== "all" && d.severity !== severity) continue;
			rows.push(d);
		}
	}
	rows.sort(
		(a, b) =>
			a.filePath.localeCompare(b.filePath) ||
			a.line - b.line ||
			a.column - b.column ||
			SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
	);
	return rows.map((d) => formatFinding(cwd, d));
}

/** Render the completed-result close chrome, or nothing for a partial result. */
export function renderClose(
	outcome: "success" | "error" | "partial",
	theme: Theme,
	width: number,
): string {
	if (outcome === "partial") return "";
	const role = outcome === "error" ? "error" : "success";
	const glyph = "- ".repeat(Math.ceil(width / 2)).slice(0, width);
	return theme.fg(role, glyph);
}

export function registerDiagnosticsTool(pi: ExtensionAPI, deps: DiagnosticsToolDeps): void {
	const { store, manager, cwd } = deps;

	pi.registerTool({
		name: "lens_diagnostics",
		label: "Diagnostics",
		renderShell: "self",
		description:
			"Report LSP diagnostics. source=session returns cached findings (all files, or " +
			"filter with paths); source=lsp runs a fresh check on 1..100 explicit paths. " +
			"Prefer source=lsp with exact paths after editing code.",
		promptSnippet:
			"lens_diagnostics(source, paths?, severity?, waitMs?) — source: session|lsp. session reads cache; lsp checks explicit paths.",
		parameters: Type.Object({
			source: StringEnum(["session", "lsp"] as const, {
				description: "session reads cached findings; lsp runs a fresh check.",
			}),
			paths: Type.Optional(
				Type.Array(Type.String(), {
					minItems: 1,
					maxItems: 100,
					description: "Files to check (lsp) or filter (session).",
				}),
			),
			severity: Type.Optional(
				StringEnum(["error", "warning", "information", "hint", "all"] as const, {
					description: "Minimum severity filter. Default all.",
				}),
			),
			waitMs: Type.Optional(
				Type.Integer({ minimum: 100, maximum: 30_000, description: "LSP wait budget in ms." }),
			),
		}),

		renderCall(args, theme, context) {
			const t = theme as Theme;
			if (hideCollapsedToolCall(context.state as CollapseState, context.expanded, () => {}))
				return new Text("", 0, 0);
			const a = args as { source?: string; paths?: string[] };
			const title = formatToolCallTitle(t, "lens_diagnostics", context);
			const src = t.fg("muted", a.source ?? "session");
			const count = a.paths?.length ? t.fg("dim", `${a.paths.length} paths`) : "";
			return new Text(`${title} ${src} ${count}`.trimEnd(), 0, 0);
		},

		renderResult(result, options, theme, context) {
			const t = theme as Theme;
			const text = result.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
			const details = result.details as DiagnosticsDetails | undefined;
			const isError = context.isError || details?.outcome === "error";
			const glyph = isError ? icon("status.error") : icon("status.done");
			const role = isError ? "error" : "success";
			const body = new Text(`${t.fg(role, glyph)} ${text}`, 0, 0);
			if (options.isPartial) return body;
			if (!details) return frameToolResult(body, theme, isError);
			if (
				tickCollapse(
					"lens_diagnostics",
					context.state as CollapseState,
					context.invalidate,
					context.expanded,
				)
			)
				return new Text(
					formatCollapsedToolRow(
						t,
						"lens_diagnostics",
						`${details.files} files`,
						[
							`${details.findings} findings`,
							details.unconfirmed ? `${details.unconfirmed} unconfirmed` : "",
							details.unavailable ? `${details.unavailable} unavailable` : "",
						]
							.filter(Boolean)
							.join(" · "),
						isError ? "error" : "success",
					),
					0,
					0,
				);
			return frameToolResult(body, theme, isError);
		},

		async execute(_id, params) {
			const source = params.source as "session" | "lsp";
			const severity = (params.severity as Severity | undefined) ?? "all";
			const paths = params.paths as string[] | undefined;

			let snapshots: DiagnosticSnapshot[];
			if (source === "session") {
				const all = store.all();
				snapshots = paths ? all.filter((s) => paths.some((p) => resolve(p) === s.filePath)) : all;
			} else {
				if (!paths || paths.length === 0) {
					throw new Error("source=lsp requires paths (1..100 files)");
				}
				const request: DiagnosticRequest = {
					paths: paths.map((p) => resolve(cwd, p)),
					severity,
					waitMs: params.waitMs as number | undefined,
				};
				snapshots = await manager.check(request);
				for (const snap of snapshots) store.set(snap);
			}

			const findings = collectFindings(cwd, snapshots, severity);
			const unconfirmed = snapshots.filter((s) => s.state === "unconfirmed").length;
			const unavailable = snapshots.filter((s) => s.state === "unavailable").length;

			let truncated = false;
			let rows = findings;
			if (rows.length > MAX_FINDINGS) {
				rows = rows.slice(0, MAX_FINDINGS);
				truncated = true;
			}
			let text = rows.length > 0 ? rows.join("\n") : summarize(snapshots);
			const capped = truncateHead(text);
			if (capped.truncated) truncated = true;
			text = capped.content;

			const details: DiagnosticsDetails = {
				_type: "pixDiagnostics",
				outcome: "success",
				files: snapshots.length,
				findings: findings.length,
				unconfirmed,
				unavailable,
				truncated,
			};
			return { content: [{ type: "text" as const, text }], details };
		},
	});
}

export function summarize(snapshots: DiagnosticSnapshot[]): string {
	if (snapshots.length === 0) return "No diagnostics.";
	const clean = snapshots.filter((s) => s.state === "clean").length;
	const parts = [`${snapshots.length} files`, `${clean} clean`];
	const unconfirmed = snapshots.filter((s) => s.state === "unconfirmed").length;
	const unavailable = snapshots.filter((s) => s.state === "unavailable").length;
	if (unconfirmed) parts.push(`${unconfirmed} unconfirmed`);
	if (unavailable) parts.push(`${unavailable} unavailable`);
	return parts.join(", ");
}
