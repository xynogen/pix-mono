/**
 * outline-tool.ts — the `ast_outline` tool.
 *
 * Syntax-only structure of a file or directory: the top-level declarations,
 * imports, and exports. No index, no LSP. Reads each supported file once,
 * parses it, and lists the named declaration nodes with their line numbers.
 */

import { relative, resolve } from "node:path";
import { type ExecuteCtx, grammarConsent } from "@xynogen/pix-pretty/grammar-consent";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { Text, type Theme } from "@xynogen/pix-pretty/tui";
import {
	frameToolResult,
	hideCollapsedToolCall,
	renderRow,
	renderTitle,
} from "@xynogen/pix-pretty/utils";
import { abortable, cancellationCheckpoint } from "@xynogen/pix-runtime/abort";
import { languageForFile, parseWithGrammar, type SgNode } from "@xynogen/pix-runtime/ast";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";
import { readFileSync } from "@xynogen/pix-runtime/fs";
import type { ExtensionAPI } from "@xynogen/pix-runtime/host";
import { Type } from "typebox";
import { collectCodeFiles } from "../files.ts";
import { grammarErrorResult } from "../grammar-result.ts";

const MAX_FILES = 500;
// Declaration node kinds worth listing, including Python's definition nodes.
const OUTLINE_KINDS = new Set([
	"function_declaration",
	"class_declaration",
	"function_definition",
	"class_definition",
	"import_from_statement",
	"abstract_class_declaration",
	"interface_declaration",
	"type_alias_declaration",
	"enum_declaration",
	"method_definition",
	"public_field_definition",
	"import_statement",
	"export_statement",
	"lexical_declaration",
]);

export interface OutlineToolDeps {
	cwd: string;
}

/** First identifier found in a bounded descent, used as the declaration name. */
function nameOf(node: SgNode, depth = 3): string {
	if (depth < 0) return "";
	for (const child of node.children()) {
		if (child.kind().endsWith("identifier")) return child.text();
	}
	for (const child of node.children()) {
		const found = nameOf(child, depth - 1);
		if (found) return found;
	}
	return "";
}

/** One outline line per top-level declaration in a parsed file. */
function outlineFile(root: SgNode): Array<{ line: number; kind: string; name: string }> {
	const rows: Array<{ line: number; kind: string; name: string }> = [];
	for (const child of root.children()) {
		const node =
			child.kind() === "decorated_definition"
				? child.children().find((node) => OUTLINE_KINDS.has(node.kind()))
				: child;
		if (!node || !OUTLINE_KINDS.has(node.kind())) continue;
		const line = node.range().start.line + 1;
		const first = node.text().split("\n")[0]?.slice(0, 80) ?? "";
		rows.push({ line, kind: node.kind(), name: nameOf(node) || first });
	}
	return rows;
}

export function registerOutlineTool(pi: ExtensionAPI, deps: OutlineToolDeps): void {
	const { cwd } = deps;

	pi.registerTool({
		name: "ast_outline",
		...({ exposure: "deferred" } as const),
		label: "AST outline",
		description:
			"Outline a file or dir: list functions, classes, types and imports (top-level declarations) with line numbers; syntax only. Extra grammars require consent and may need an agent restart.",
		promptSnippet: "ast_outline(path) — file or dir structure, syntax only.",
		parameters: Type.Object({
			path: Type.String({ description: "File or directory to outline." }),
		}),

		renderCall(args, theme, context) {
			if (hideCollapsedToolCall(context.state as CollapseState, context.expanded, () => {}))
				return new Text("", 0, 0);
			const t = theme as Theme;
			const a = args as { path?: string };
			const title = renderTitle(t, "ast_outline", context);
			return new Text(`${title} ${t.fg("dim", a.path ?? "")}`.trimEnd(), 0, 0);
		},

		renderResult(result, options, theme, context) {
			const t = theme as Theme;
			const text = result.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
			const details = result.details as { outcome?: string } | undefined;
			const isError = context.isError || details?.outcome === "error";
			if (
				!options.isPartial &&
				tickCollapse(
					"ast_outline",
					context.state as CollapseState,
					context.invalidate,
					options.expanded,
				)
			)
				return new Text(
					renderRow(
						theme,
						"ast_outline",
						"",
						`${text.split("\n").length} lines`,
						isError ? "error" : "success",
					),
					0,
					0,
				);
			const glyph = isError ? icon("status.error") : icon("status.ok");
			const role = isError ? "error" : "success";
			const body = new Text(`${t.fg(role, glyph)} ${text}`, 0, 0);
			if (options.isPartial) return body;
			return frameToolResult(body, theme, isError);
		},

		async execute(_id, params, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			const path = params.path as string;
			const consent = grammarConsent(ctx as ExecuteCtx, signal);

			const files: string[] = [];
			await collectCodeFiles(resolve(cwd, path), files, MAX_FILES, signal);

			const blocks: string[] = [];
			let symbols = 0;
			for (const file of files) {
				await cancellationCheckpoint(signal);
				const lang = languageForFile(file);
				if (!lang) continue;
				let source: string;
				try {
					source = readFileSync(file, "utf8");
				} catch {
					continue;
				}
				const parsed = await abortable(parseWithGrammar(lang, source, consent, signal), signal);
				signal?.throwIfAborted();
				if (parsed.kind !== "ok") {
					return grammarErrorResult(parsed, lang, "pixOutline");
				}
				const rows = outlineFile(parsed.root);
				if (rows.length === 0) continue;
				symbols += rows.length;
				const rel = relative(cwd, file);
				const lines = rows.map((r) => `  ${r.line}: ${r.kind}  ${r.name}`);
				blocks.push(`${rel}\n${lines.join("\n")}`);
			}

			const text =
				blocks.length > 0 ? blocks.join("\n\n") : `No declarations in ${files.length} file(s).`;
			return {
				content: [{ type: "text" as const, text }],
				details: { _type: "pixOutline", outcome: symbols > 0 ? "success" : "empty", symbols },
			};
		},
	});
}
