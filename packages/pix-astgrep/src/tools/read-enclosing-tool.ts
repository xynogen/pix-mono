/**
 * read-enclosing-tool.ts — the `ast` tool's `enclosing` action.
 *
 * The reverse of the `symbol` action: given a line, return the smallest named
 * declaration that encloses it. Use it when you know a location but not the
 * symbol name. Supports the six ast-grep grammars.
 */

import { relative, resolve } from "node:path";
import { type ExecuteCtx, grammarConsent } from "@xynogen/pix-pretty/grammar-consent";
import { abortable, cancellationCheckpoint } from "@xynogen/pix-runtime/abort";
import { languageForFile, parseWithGrammar, type SgNode } from "@xynogen/pix-runtime/ast";
import { readFileSync } from "@xynogen/pix-runtime/fs";
import { defineTool } from "@xynogen/pix-runtime/host";
import { truncateStringToBytes } from "@xynogen/pix-runtime/utf8";
import { Type } from "typebox";
import { grammarErrorResult } from "../grammar-result.ts";
import { astCall, astResult } from "../render.ts";

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

export function readEnclosingTool(deps: ReadEnclosingToolDeps) {
	const { cwd } = deps;

	return defineTool({
		name: "enclosing",
		label: "Read enclosing",
		description: "Read the smallest declaration covering a one-based line. Grammar-dependent.",
		parameters: Type.Object({
			path: Type.String({ description: "Source file, e.g. `src/app.ts`." }),
			line: Type.Integer({ minimum: 1, description: "One-based line inside the symbol." }),
		}),

		renderCall: astCall<{ path?: string; line?: number }>("enclosing", (a, t) =>
			a.path ? t.fg("dim", `${a.path}:${a.line ?? ""}`) : "",
		),
		renderResult: astResult("enclosing"),

		async execute(_id, params, signal, _onUpdate, ctx) {
			await cancellationCheckpoint(signal);
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

			const parsed = await abortable(
				parseWithGrammar(lang, source, grammarConsent(ctx as ExecuteCtx, signal), signal),
				signal,
			);
			signal?.throwIfAborted();
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
				body = truncateStringToBytes(body, MAX_BYTES);
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
