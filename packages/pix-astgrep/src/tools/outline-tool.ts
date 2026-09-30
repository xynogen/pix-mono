/**
 * outline-tool.ts — the `ast_grep_outline` tool.
 *
 * Syntax-only structure of a file or directory: the top-level declarations,
 * imports, and exports. No index, no LSP. Reads each supported file once,
 * parses it, and lists the named declaration nodes with their line numbers.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { frameToolResult } from "@xynogen/pix-pretty/utils";
import { Type } from "typebox";
import { type ExecuteCtx, grammarConsent } from "../consent.ts";
import { languageForFile, type SgNode } from "../engine.ts";
import { type ConsentFn, parseWithGrammar } from "../grammars.ts";

const MAX_FILES = 500;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage"]);
const CODE_EXT = new Set([
	".ts",
	".mts",
	".cts",
	".tsx",
	".js",
	".mjs",
	".cjs",
	".jsx",
	".css",
	".html",
	".htm",
]);

// Declaration node kinds worth listing in an outline, across the six grammars.
const OUTLINE_KINDS = new Set([
	"function_declaration",
	"class_declaration",
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

/** Collect parseable code files under one path, bounded. */
function collectFiles(root: string, out: string[]): void {
	if (out.length >= MAX_FILES) return;
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(root);
	} catch {
		return;
	}
	if (stat.isFile()) {
		if (CODE_EXT.has(extname(root).toLowerCase())) out.push(root);
		return;
	}
	if (!stat.isDirectory()) return;
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (out.length >= MAX_FILES) return;
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			collectFiles(join(root, entry.name), out);
		} else if (CODE_EXT.has(extname(entry.name).toLowerCase())) {
			out.push(join(root, entry.name));
		}
	}
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
	for (const node of root.children()) {
		if (!OUTLINE_KINDS.has(node.kind())) continue;
		const line = node.range().start.line + 1;
		const first = node.text().split("\n")[0]?.slice(0, 80) ?? "";
		rows.push({ line, kind: node.kind(), name: nameOf(node) || first });
	}
	return rows;
}

export function registerOutlineTool(pi: ExtensionAPI, deps: OutlineToolDeps): void {
	const { cwd } = deps;

	pi.registerTool({
		name: "ast_grep_outline",
		...({ exposure: "deferred" } as const),
		label: "AST outline",
		description:
			"Syntax-only structure of a file or directory: top-level declarations, imports, and " +
			"exports with line numbers. No index, no LSP. Supports ts, tsx, js, jsx, css, html.",
		promptSnippet: "ast_grep_outline(path) — file or dir structure, syntax only.",
		parameters: Type.Object({
			path: Type.String({ description: "File or directory to outline." }),
		}),

		renderCall(args, theme) {
			const t = theme as Theme;
			const a = args as { path?: string };
			const title = t.fg("toolTitle", t.bold("ast_grep_outline"));
			return new Text(`${title} ${t.fg("dim", a.path ?? "")}`.trimEnd(), 0, 0);
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
			const consent: ConsentFn = grammarConsent(ctx as ExecuteCtx);

			const files: string[] = [];
			collectFiles(resolve(cwd, path), files);

			const blocks: string[] = [];
			const skippedLangs = new Set<string>();
			let symbols = 0;
			for (const file of files) {
				const lang = languageForFile(file);
				if (!lang) continue;
				let source: string;
				try {
					source = readFileSync(file, "utf8");
				} catch {
					continue;
				}
				const parsed = await parseWithGrammar(lang, source, consent);
				if (parsed.kind !== "ok") {
					if (parsed.kind === "declined" || parsed.kind === "needs-install") skippedLangs.add(lang);
					continue;
				}
				const rows = outlineFile(parsed.root);
				if (rows.length === 0) continue;
				symbols += rows.length;
				const rel = relative(cwd, file);
				const lines = rows.map((r) => `  ${r.line}: ${r.kind}  ${r.name}`);
				blocks.push(`${rel}\n${lines.join("\n")}`);
			}

			const skipNote =
				skippedLangs.size > 0 ? `\n(skipped, no grammar: ${[...skippedLangs].join(", ")})` : "";
			const text =
				(blocks.length > 0 ? blocks.join("\n\n") : `No declarations in ${files.length} file(s).`) +
				skipNote;
			return {
				content: [{ type: "text" as const, text }],
				details: { _type: "pixOutline", outcome: symbols > 0 ? "success" : "empty", symbols },
			};
		},
	});
}
