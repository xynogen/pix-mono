/**
 * mark-tool.ts — the `lsp` tool's `mark` action.
 *
 * Record a disposition for a diagnostic: false-positive, suppress, defer, or
 * flagged. It also lists and clears dispositions. This is visible, auditable
 * session memory — no file is changed and no analysis is hidden.
 */

import { relative, resolve } from "node:path";
import { StringEnum } from "@xynogen/pix-data/ai";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { Text, type Theme } from "@xynogen/pix-pretty/tui";
import { frameToolResult, renderCall, renderRow } from "@xynogen/pix-pretty/utils";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";
import { defineTool } from "@xynogen/pix-runtime/host";
import { Type } from "typebox";
import type { Disposition, DispositionStore } from "../dispositions.ts";

export interface MarkToolDeps {
	store: DispositionStore;
	cwd: string;
}

export function markTool(deps: MarkToolDeps) {
	const { store, cwd } = deps;

	return defineTool({
		name: "mark",
		label: "Mark diagnostic",
		renderShell: "self",
		description:
			"Session-only diagnostic marks; no file changes. set needs path/code/disposition; clear removes one (path/code) or all.",
		parameters: Type.Object({
			op: StringEnum(["set", "list", "clear"] as const, {
				description: "set (path, code, disposition), list, or clear (path+code, or all).",
			}),
			path: Type.Optional(Type.String()),
			code: Type.Optional(Type.String({ description: "Diagnostic code or identity." })),
			disposition: Type.Optional(
				StringEnum(["false-positive", "suppress", "defer", "flagged"] as const, {
					description: "Disposition for op=set.",
				}),
			),
			note: Type.Optional(Type.String()),
		}),

		renderCall: renderCall(
			"lsp",
			(args) => String(args.disposition ?? ""),
			(args) => `mark ${String(args.op ?? "")}`.trimEnd(),
		),

		renderResult(result, options, theme, context) {
			const t = theme as Theme;
			const text = result.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
			const details = result.details as
				| {
						outcome?: string;
						count?: number;
						cleared?: number;
						disposition?: string;
				  }
				| undefined;
			const isError = context.isError || details?.outcome === "error";
			const glyph = isError ? icon("status.error") : icon("status.done");
			const role = isError ? "error" : "success";
			const body = new Text(`${t.fg(role, glyph)} ${text}`, 0, 0);
			if (options.isPartial) return body;
			if (!details) return frameToolResult(body, theme, isError);
			if (tickCollapse("lsp", context.state as CollapseState, context.invalidate, context.expanded))
				return new Text(
					renderRow(
						t,
						"lsp · mark",
						"",
						isError
							? "failed"
							: details.count !== undefined
								? `${details.count} marks`
								: details.cleared !== undefined
									? `${details.cleared} cleared`
									: `marked ${details.disposition ?? "done"}`,
						isError ? "error" : "success",
					),
					0,
					0,
				);
			return frameToolResult(body, theme, isError);
		},

		async execute(_id, params) {
			const op = params.op as "set" | "list" | "clear";

			if (op === "list") {
				const rows = store.list();
				const lines = rows.map(
					(r) =>
						`${relative(cwd, r.filePath)}  ${r.code}  ${r.disposition}${r.note ? `  — ${r.note}` : ""}`,
				);
				const text = lines.length > 0 ? lines.join("\n") : "No dispositions.";
				return {
					content: [{ type: "text" as const, text }],
					details: { _type: "pixMark", outcome: "success", count: rows.length },
				};
			}

			if (op === "clear") {
				const path = params.path as string | undefined;
				const code = params.code as string | undefined;
				if (path && code) {
					const removed = store.delete(resolve(cwd, path), code);
					return {
						content: [
							{
								type: "text" as const,
								text: removed ? "Cleared 1 disposition." : "Nothing to clear.",
							},
						],
						details: { _type: "pixMark", outcome: "success", cleared: removed ? 1 : 0 },
					};
				}
				const count = store.list().length;
				store.clear();
				return {
					content: [{ type: "text" as const, text: `Cleared ${count} disposition(s).` }],
					details: { _type: "pixMark", outcome: "success", cleared: count },
				};
			}

			// op === "set"
			const path = params.path as string | undefined;
			const code = params.code as string | undefined;
			const disposition = params.disposition as Disposition | undefined;
			if (!path || !code || !disposition) {
				throw new Error("set requires path, code, and disposition");
			}
			const rec = store.set(
				resolve(cwd, path),
				code,
				disposition,
				params.note as string | undefined,
			);
			return {
				content: [
					{
						type: "text" as const,
						text: `Marked ${relative(cwd, rec.filePath)} ${rec.code} as ${rec.disposition}.`,
					},
				],
				details: { _type: "pixMark", outcome: "success", disposition: rec.disposition },
			};
		},
	});
}
