/**
 * symbol-search-tool.ts — the `symbol_search` tool.
 *
 * Rank files by how well they match an identifier query. This is an on-demand
 * bounded scan, not a persisted index and not a background loop. It reads each
 * code file once, counts whole-word matches of each query term, and returns the
 * top files by score. Use it to find where a symbol lives before reading it.
 *
 * `ponytail:` term-frequency ranking, no IDF or centrality. Good enough to
 * locate a file. Upgrade to a real index only if ranking quality is too weak.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
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

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 512 * 1024;
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
	".py",
	".go",
	".rs",
	".java",
	".rb",
	".php",
	".c",
	".h",
	".cpp",
	".cs",
	".css",
	".html",
]);

export interface SymbolSearchToolDeps {
	cwd: string;
}

/** Walk into a bounded list of code files under one root. */
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

/** Count whole-word occurrences of each term. A file must match every term. */
function scoreFile(source: string, terms: readonly string[]): number {
	let total = 0;
	for (const term of terms) {
		// ReDoS-safe: every regex metacharacter in `term` is escaped, so the pattern
		// is a literal word match with no attacker-controlled quantifiers.
		const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
		const count = (source.match(re) ?? []).length;
		if (count === 0) return 0;
		total += count;
	}
	return total;
}

export function registerSymbolSearchTool(pi: ExtensionAPI, deps: SymbolSearchToolDeps): void {
	const { cwd } = deps;

	pi.registerTool({
		name: "symbol_search",
		...({ exposure: "deferred" } as const),
		label: "Symbol search",
		description:
			"Find files by identifier. Ranks code files by how often they contain the query terms. " +
			"On-demand bounded scan, no persisted index. Use it to locate where a symbol lives " +
			"before you read it. Space-separated terms are AND-matched.",
		promptSnippet: "symbol_search(query, paths?, limit?) — rank files by identifier.",
		parameters: Type.Object({
			query: Type.String({ description: "Identifier terms, e.g. `authenticate user`." }),
			paths: Type.Optional(
				Type.Array(Type.String(), {
					description: "Dirs or files to scope the scan (default: cwd).",
				}),
			),
			limit: Type.Optional(
				Type.Integer({ minimum: 1, maximum: MAX_LIMIT, description: "Max files (default 20)." }),
			),
		}),

		renderCall(args, theme, context) {
			if (hideCollapsedToolCall(context.state as CollapseState, context.expanded, () => {}))
				return new Text("", 0, 0);
			const t = theme as Theme;
			const a = args as { query?: string };
			const title = formatToolCallTitle(t, "symbol_search", context);
			const q = t.fg("dim", `“${a.query ?? ""}”`);
			return new Text(`${title} ${q}`, 0, 0);
		},

		renderResult(result, options, theme, context) {
			const t = theme as Theme;
			const text = result.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
			const details = result.details as { outcome?: string } | undefined;
			const isError = context.isError || details?.outcome === "error";
			if (
				!options.isPartial &&
				tickCollapse(
					"symbol_search",
					context.state as CollapseState,
					context.invalidate,
					options.expanded,
				)
			)
				return new Text(
					formatCollapsedToolRow(
						theme,
						"symbol_search",
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

		async execute(_id, params) {
			const query = params.query as string;
			const limit = Math.min(MAX_LIMIT, (params.limit as number | undefined) ?? DEFAULT_LIMIT);
			const rawPaths = (params.paths as string[] | undefined) ?? ["."];
			const terms = query.split(/\s+/).filter((t) => t.length > 0);
			if (terms.length === 0) {
				return {
					content: [{ type: "text" as const, text: "Empty query." }],
					details: { _type: "pixSymbolSearch", outcome: "empty" },
				};
			}

			const files: string[] = [];
			for (const p of rawPaths) collectFiles(resolve(cwd, p), files);

			const scored: Array<{ file: string; score: number }> = [];
			for (const file of files) {
				let source: string;
				try {
					const stat = statSync(file);
					if (stat.size > MAX_FILE_BYTES) continue;
					source = readFileSync(file, "utf8");
				} catch {
					continue;
				}
				const score = scoreFile(source, terms);
				if (score > 0) scored.push({ file: relative(cwd, file), score });
			}
			scored.sort((a, b) => b.score - a.score);
			const top = scored.slice(0, limit);

			const lines = top.map((s) => `${s.file}  (${s.score})`);
			const text =
				lines.length > 0
					? lines.join("\n")
					: `No files match "${query}" in ${files.length} file(s).`;
			return {
				content: [{ type: "text" as const, text }],
				details: {
					_type: "pixSymbolSearch",
					outcome: top.length > 0 ? "success" : "empty",
					count: top.length,
					scanned: files.length,
				},
			};
		},
	});
}
