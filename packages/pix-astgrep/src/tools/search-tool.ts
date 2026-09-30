/**
 * search-tool.ts — the `ast_grep_search` tool.
 *
 * AST-aware structural search. The agent gives an ast-grep pattern and a
 * language (or lets the tool infer it per file). The tool walks explicit paths
 * or files, parses each supported file, and returns match locations with the
 * matched text. Unsupported languages are skipped with a clear note.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { frameToolResult } from "@xynogen/pix-pretty/utils";
import { Type } from "typebox";
import { type ExecuteCtx, grammarConsent } from "../consent.ts";
import { ALL_LANGUAGES, type AnyLanguage, languageForFile } from "../engine.ts";
import { parseWithGrammar } from "../grammars.ts";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
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

export interface SearchToolDeps {
	cwd: string;
}

interface Match {
	file: string;
	line: number;
	column: number;
	text: string;
}

/** Walk a path into a bounded list of parseable code files. */
function collectFiles(root: string, out: string[], cap: number): void {
	if (out.length >= cap) return;
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
		if (out.length >= cap) return;
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			collectFiles(join(root, entry.name), out, cap);
		} else if (CODE_EXT.has(extname(entry.name).toLowerCase())) {
			out.push(join(root, entry.name));
		}
	}
}

export function registerSearchTool(pi: ExtensionAPI, deps: SearchToolDeps): void {
	const { cwd } = deps;

	pi.registerTool({
		name: "ast_grep_search",
		...({ exposure: "deferred" } as const),
		label: "AST search",
		description:
			"AST-aware structural code search. Give an ast-grep `pattern` (metavariables like " +
			"$A, $$$ARGS) and search `paths` (files or dirs). `lang` forces one grammar; without it " +
			"each file uses its extension. Supports ts, tsx, js, jsx, css, html.",
		promptSnippet: "ast_grep_search(pattern, paths?, lang?, limit?) — structural code search.",
		parameters: Type.Object({
			pattern: Type.String({ description: "ast-grep pattern, e.g. `foo($A)` or `useState($$$)`." }),
			paths: Type.Optional(
				Type.Array(Type.String(), { description: "Files or dirs to search (default: cwd)." }),
			),
			lang: Type.Optional(
				StringEnum([...ALL_LANGUAGES], {
					description:
						"Force one language. Non-bundled languages install a grammar on first use (with your ok).",
				}),
			),
			limit: Type.Optional(
				Type.Integer({ minimum: 1, maximum: MAX_LIMIT, description: "Max matches (default 100)." }),
			),
		}),

		renderCall(args, theme) {
			const t = theme as Theme;
			const a = args as { pattern?: string; lang?: string };
			const title = t.fg("toolTitle", t.bold("ast_grep_search"));
			const pat = t.fg("dim", a.pattern ?? "");
			const lang = a.lang ? t.fg("muted", ` · ${a.lang}`) : "";
			return new Text(`${title} ${pat}${lang}`.trimEnd(), 0, 0);
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
			const pattern = params.pattern as string;
			const forcedLang = params.lang as AnyLanguage | undefined;
			const limit = Math.min(MAX_LIMIT, (params.limit as number | undefined) ?? DEFAULT_LIMIT);
			const rawPaths = (params.paths as string[] | undefined) ?? ["."];
			const consent = grammarConsent(ctx as ExecuteCtx);

			const files: string[] = [];
			for (const p of rawPaths) collectFiles(resolve(cwd, p), files, 5000);

			const matches: Match[] = [];
			const skippedLangs = new Set<string>();
			let scanned = 0;
			for (const file of files) {
				if (matches.length >= limit) break;
				const lang = forcedLang ?? languageForFile(file);
				if (!lang) continue;
				let source: string;
				try {
					source = readFileSync(file, "utf8");
				} catch {
					continue;
				}
				scanned++;
				const parsed = await parseWithGrammar(lang, source, consent);
				if (parsed.kind !== "ok") {
					if (parsed.kind === "declined" || parsed.kind === "needs-install") skippedLangs.add(lang);
					continue;
				}
				for (const node of parsed.root.findAll(pattern)) {
					if (matches.length >= limit) break;
					const r = node.range();
					matches.push({
						file: relative(cwd, file),
						line: r.start.line + 1,
						column: r.start.column + 1,
						text: node.text().split("\n")[0] ?? "",
					});
				}
			}

			const lines = matches.map((m) => `${m.file}:${m.line}:${m.column}  ${m.text}`);
			const skipNote =
				skippedLangs.size > 0 ? `\n(skipped, no grammar: ${[...skippedLangs].join(", ")})` : "";
			const text =
				(lines.length > 0 ? lines.join("\n") : `No matches in ${scanned} file(s).`) + skipNote;
			return {
				content: [{ type: "text" as const, text }],
				details: {
					_type: "pixAstGrep",
					outcome: matches.length > 0 ? "success" : "empty",
					matches: matches.length,
					scanned,
				},
			};
		},
	});
}
