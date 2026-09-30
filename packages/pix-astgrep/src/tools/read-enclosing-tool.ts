/**
 * read-enclosing-tool.ts — the `read_enclosing` tool.
 *
 * The reverse of `read_symbol`: given a line, return the smallest named
 * declaration that encloses it. Use it when you know a location but not the
 * symbol name. Supports the six ast-grep grammars.
 */

import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { frameToolResult } from "@xynogen/pix-pretty/utils";
import { Type } from "typebox";
import { type ExecuteCtx, grammarConsent } from "../consent.ts";
import { languageForFile, type SgNode } from "../engine.ts";
import { grammarErrorResult } from "../grammar-result.ts";
import { parseWithGrammar } from "../grammars.ts";

const MAX_BYTES = 16 * 1024;

// Declaration node kinds that count as an enclosing symbol, across grammars.
const DECL_KINDS = new Set([
	"function_declaration",
	"method_definition",
	"class_declaration",
	"abstract_class_declaration",
	"interface_declaration",
	"type_alias_declaration",
	"enum_declaration",
	"lexical_declaration",
	"public_field_definition",
]);

export interface ReadEnclosingToolDeps {
	cwd: string;
}

/** Smallest declaration node whose range covers the zero-based line. */
function findEnclosing(root: SgNode, line: number): SgNode | undefined {
	const stack: SgNode[] = [root];
	let best: SgNode | undefined;
	while (stack.length > 0) {
		const node = stack.pop();
		if (!node) continue;
		const r = node.range();
		const covers = r.start.line <= line && line <= r.end.line;
		if (covers && DECL_KINDS.has(node.kind())) {
			if (!best || node.text().length < best.text().length) best = node;
		}
		if (covers) for (const child of node.children()) stack.push(child);
	}
	return best;
}

/** First identifier child text, used as the symbol name. */
function nameOf(node: SgNode): string {
	for (const child of node.children()) {
		if (child.kind().endsWith("identifier")) return child.text();
	}
	return node.kind();
}

export function registerReadEnclosingTool(pi: ExtensionAPI, deps: ReadEnclosingToolDeps): void {
	const { cwd } = deps;

	pi.registerTool({
		name: "read_enclosing",
		...({ exposure: "deferred" } as const),
		label: "Read enclosing",
		description:
			"Return the smallest named declaration that encloses a line (the reverse of read_symbol). " +
			"Use it when you know a location but not the symbol name. Supports ts, tsx, js, jsx, css, html.",
		promptSnippet: "read_enclosing(path, line) — smallest symbol covering a line.",
		parameters: Type.Object({
			path: Type.String({ description: "Source file, e.g. `src/app.ts`." }),
			line: Type.Integer({ minimum: 1, description: "One-based line inside the symbol." }),
		}),

		renderCall(args, theme) {
			const t = theme as Theme;
			const a = args as { path?: string; line?: number };
			const title = t.fg("toolTitle", t.bold("read_enclosing"));
			const loc = a.path ? t.fg("dim", `${a.path}:${a.line ?? ""}`) : "";
			return new Text(`${title} ${loc}`.trimEnd(), 0, 0);
		},

		renderResult(result, options, theme, context) {
			const t = theme as Theme;
			const text = result.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
			const details = result.details as { outcome?: string } | undefined;
			const isError = context.isError || details?.outcome === "error";
			const glyph = isError ? icon("status.error") : icon("status.done");
			const role = isError ? "error" : "success";
			const body = new Text(`${t.fg(role, glyph)} ${text}`, 0, 0);
			if (options.isPartial || !details) return body;
			return frameToolResult(body, theme, isError);
		},

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const path = params.path as string;
			const line = params.line as number;
			const abs = resolve(cwd, path);
			const rel = relative(cwd, abs);

			const lang = languageForFile(abs);
			if (!lang) {
				return {
					content: [{ type: "text" as const, text: `Unsupported language for ${rel}.` }],
					details: { _type: "pixReadEnclosing", outcome: "unsupported" },
					isError: true,
				};
			}
			let source: string;
			try {
				source = readFileSync(abs, "utf8");
			} catch {
				return {
					content: [{ type: "text" as const, text: `Cannot read ${rel}.` }],
					details: { _type: "pixReadEnclosing", outcome: "error" },
					isError: true,
				};
			}

			const parsed = await parseWithGrammar(lang, source, grammarConsent(ctx as ExecuteCtx));
			if (parsed.kind !== "ok") {
				return grammarErrorResult(parsed, lang, "pixReadEnclosing");
			}
			const node = findEnclosing(parsed.root, line - 1);
			if (!node) {
				return {
					content: [{ type: "text" as const, text: `No enclosing declaration at ${rel}:${line}.` }],
					details: { _type: "pixReadEnclosing", outcome: "empty" },
					isError: true,
				};
			}

			let body = node.text();
			let truncated = false;
			if (Buffer.byteLength(body, "utf8") > MAX_BYTES) {
				body = body.slice(0, MAX_BYTES);
				truncated = true;
			}
			const startLine = node.range().start.line + 1;
			const header = `${rel}:${startLine}  ${nameOf(node)}${truncated ? " (truncated)" : ""}`;
			return {
				content: [{ type: "text" as const, text: `${header}\n${body}` }],
				details: { _type: "pixReadEnclosing", outcome: "success", line: startLine, truncated },
			};
		},
	});
}
