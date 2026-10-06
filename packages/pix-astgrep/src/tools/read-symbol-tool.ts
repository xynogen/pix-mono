/**
 * read-symbol-tool.ts — the `read_symbol` tool.
 *
 * Return the exact source of one named top-level symbol in a file. It parses
 * the file with ast-grep and finds a declaration node whose name matches. This
 * gives the agent a symbol body without reading the whole file.
 *
 * Covers the six ast-grep grammars. For a language it cannot parse, it returns
 * a clear "unsupported" result.
 */

import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
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
import { type ExecuteCtx, grammarConsent } from "../consent.ts";
import { languageForFile, type SgNode } from "../engine.ts";
import { grammarErrorResult } from "../grammar-result.ts";
import { parseWithGrammar } from "../grammars.ts";

const MAX_BYTES = 16 * 1024;

// Declaration node kinds that carry a named symbol, across the six grammars.
const DECL_KINDS = new Set([
	"function_declaration",
	"method_definition",
	"class_declaration",
	"interface_declaration",
	"type_alias_declaration",
	"enum_declaration",
	"variable_declarator",
	"lexical_declaration",
	"public_field_definition",
	"abstract_class_declaration",
]);

export interface ReadSymbolToolDeps {
	cwd: string;
}

/** Find the smallest declaration node whose identifier child equals `name`. */
function findSymbol(root: SgNode, name: string): SgNode | undefined {
	const stack: SgNode[] = [root];
	let best: SgNode | undefined;
	while (stack.length > 0) {
		const node = stack.pop();
		if (!node) continue;
		if (DECL_KINDS.has(node.kind())) {
			// An identifier child with the exact name marks this declaration.
			const named = node.children().some((c) => {
				return c.kind().endsWith("identifier") && c.text() === name;
			});
			if (named) {
				if (!best || node.text().length < best.text().length) best = node;
			}
		}
		for (const child of node.children()) stack.push(child);
	}
	return best;
}

export function registerReadSymbolTool(pi: ExtensionAPI, deps: ReadSymbolToolDeps): void {
	const { cwd } = deps;

	pi.registerTool({
		name: "read_symbol",
		...({ exposure: "deferred" } as const),
		label: "Read symbol",
		description:
			"Return the exact source of one named symbol (function, class, interface, type, enum, " +
			"const) in a file, without reading the whole file. Supports ts, tsx, js, jsx, css, html.",
		promptSnippet: "read_symbol(path, symbol) — one symbol's source.",
		parameters: Type.Object({
			path: Type.String({ description: "Source file, e.g. `src/app.ts`." }),
			symbol: Type.String({ description: "Exact symbol name to read." }),
		}),

		renderCall(args, theme, context) {
			if (hideCollapsedToolCall(context.state as CollapseState, context.expanded, () => {}))
				return new Text("", 0, 0);
			const t = theme as Theme;
			const a = args as { path?: string; symbol?: string };
			const title = formatToolCallTitle(t, "read_symbol", context);
			const sym = t.fg("dim", a.symbol ?? "");
			const path = a.path ? t.fg("muted", ` · ${a.path}`) : "";
			return new Text(`${title} ${sym}${path}`.trimEnd(), 0, 0);
		},

		renderResult(result, options, theme, context) {
			const t = theme as Theme;
			const text = result.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
			const details = result.details as { outcome?: string } | undefined;
			const isError = context.isError || details?.outcome === "error";
			if (
				!options.isPartial &&
				tickCollapse(
					"read_symbol",
					context.state as CollapseState,
					context.invalidate,
					options.expanded,
				)
			)
				return new Text(
					formatCollapsedToolRow(
						theme,
						"read_symbol",
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

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const path = params.path as string;
			const symbol = params.symbol as string;
			const abs = resolve(cwd, path);
			const rel = relative(cwd, abs);

			const lang = languageForFile(abs);
			if (!lang) {
				return {
					content: [{ type: "text" as const, text: `Unsupported language for ${rel}.` }],
					details: { _type: "pixReadSymbol", outcome: "unsupported" },
					isError: true,
				};
			}

			let source: string;
			try {
				source = readFileSync(abs, "utf8");
			} catch {
				return {
					content: [{ type: "text" as const, text: `Cannot read ${rel}.` }],
					details: { _type: "pixReadSymbol", outcome: "error" },
					isError: true,
				};
			}

			const parsed = await parseWithGrammar(lang, source, grammarConsent(ctx as ExecuteCtx));
			if (parsed.kind !== "ok") {
				return grammarErrorResult(parsed, lang, "pixReadSymbol");
			}
			const node = findSymbol(parsed.root, symbol);
			if (!node) {
				return {
					content: [{ type: "text" as const, text: `Symbol "${symbol}" not found in ${rel}.` }],
					details: { _type: "pixReadSymbol", outcome: "empty" },
					isError: true,
				};
			}

			let body = node.text();
			let truncated = false;
			if (Buffer.byteLength(body, "utf8") > MAX_BYTES) {
				body = body.slice(0, MAX_BYTES);
				truncated = true;
			}
			const line = node.range().start.line + 1;
			const header = `${rel}:${line}  ${symbol}${truncated ? " (truncated)" : ""}`;
			return {
				content: [{ type: "text" as const, text: `${header}\n${body}` }],
				details: { _type: "pixReadSymbol", outcome: "success", line, truncated },
			};
		},
	});
}
