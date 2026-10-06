/**
 * replace-tool.ts — the `ast_grep_replace` tool.
 *
 * AST-aware structural rewrite. The agent gives a `pattern` and a `rewrite`,
 * both with metavariables ($A, $$$ARGS). The tool matches each file, resolves
 * the metavariables per match, and reports a unified diff. It previews by
 * default. It writes files only when `apply` is true — a visible, explicit
 * mutation.
 *
 * `ponytail:` metavariable substitution is a text replace of $NAME tokens in
 * the rewrite with each match's captured text. It handles $single and $$$multi.
 * It does not evaluate ast-grep transforms. Upgrade if a transform is needed.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
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
import {
	ALL_LANGUAGES,
	type AnyLanguage,
	languageForFile,
	type SgEdit,
	type SgNode,
} from "../engine.ts";
import { parseWithGrammar } from "../grammars.ts";

const MAX_LIMIT = 500;
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

export interface ReplaceToolDeps {
	cwd: string;
}

/** Walk a path into a bounded list of parseable code files. */
function collectFiles(root: string, out: string[]): void {
	if (out.length >= 5000) return;
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
		if (out.length >= 5000) return;
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			collectFiles(join(root, entry.name), out);
		} else if (CODE_EXT.has(extname(entry.name).toLowerCase())) {
			out.push(join(root, entry.name));
		}
	}
}

/** Resolve $A and $$$ARGS tokens in `rewrite` from one match's captures. */
function fillRewrite(match: SgNode, rewrite: string): string {
	// $$$NAME → joined multi-match text; $NAME → single-match text.
	return rewrite
		.replace(/\$\$\$([A-Z_][A-Z0-9_]*)/g, (_m, name: string) => {
			return match
				.getMultipleMatches(name)
				.map((n) => n.text())
				.join(", ");
		})
		.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_m, name: string) => {
			const n = match.getMatch(name);
			return n ? n.text() : `$${name}`;
		});
}

/** A minimal per-file unified-ish diff: changed lines only, with context. */
function summarizeChange(rel: string, before: string, after: string): string {
	const b = before.split("\n");
	const a = after.split("\n");
	const out: string[] = [`--- ${rel}`, `+++ ${rel}`];
	const max = Math.max(b.length, a.length);
	for (let i = 0; i < max; i++) {
		if (b[i] !== a[i]) {
			if (b[i] !== undefined) out.push(`-${i + 1}: ${b[i]}`);
			if (a[i] !== undefined) out.push(`+${i + 1}: ${a[i]}`);
		}
	}
	return out.join("\n");
}

export function registerReplaceTool(pi: ExtensionAPI, deps: ReplaceToolDeps): void {
	const { cwd } = deps;

	pi.registerTool({
		name: "ast_grep_replace",
		...({ exposure: "deferred" } as const),
		label: "AST replace",
		description:
			"AST-aware structural rewrite. Give a `pattern` and a `rewrite`, both with metavariables " +
			"($A, $$$ARGS). Previews a diff by default. Set apply=true to write the files. Supports " +
			"ts, tsx, js, jsx, css, html.",
		promptSnippet:
			"ast_grep_replace(pattern, rewrite, paths?, lang?, apply?) — preview by default.",
		parameters: Type.Object({
			pattern: Type.String({ description: "ast-grep match pattern, e.g. `foo($A)`." }),
			rewrite: Type.String({ description: "Replacement, e.g. `bar($A)`." }),
			paths: Type.Optional(
				Type.Array(Type.String(), { description: "Files or dirs (default: cwd)." }),
			),
			lang: Type.Optional(
				StringEnum([...ALL_LANGUAGES], {
					description:
						"Force one language. Non-bundled languages install a grammar on first use (with your ok).",
				}),
			),
			apply: Type.Optional(
				Type.Boolean({ description: "Write the files. Default false (preview only)." }),
			),
		}),

		renderCall(args, theme, context) {
			if (hideCollapsedToolCall(context.state as CollapseState, context.expanded, () => {}))
				return new Text("", 0, 0);
			const t = theme as Theme;
			const a = args as { pattern?: string; rewrite?: string; apply?: boolean };
			const title = formatToolCallTitle(t, "ast_grep_replace", context);
			const rule = t.fg("dim", `${a.pattern ?? ""} → ${a.rewrite ?? ""}`);
			const mode = t.fg("muted", a.apply ? " · apply" : " · preview");
			return new Text(`${title} ${rule}${mode}`, 0, 0);
		},

		renderResult(result, options, theme, context) {
			const t = theme as Theme;
			const text = result.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
			const details = result.details as { outcome?: string } | undefined;
			const isError = context.isError || details?.outcome === "error";
			if (
				!options.isPartial &&
				tickCollapse(
					"ast_grep_replace",
					context.state as CollapseState,
					context.invalidate,
					options.expanded,
				)
			)
				return new Text(
					formatCollapsedToolRow(
						theme,
						"ast_grep_replace",
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
			const pattern = params.pattern as string;
			const rewrite = params.rewrite as string;
			const apply = (params.apply as boolean | undefined) ?? false;
			const forcedLang = params.lang as AnyLanguage | undefined;
			const rawPaths = (params.paths as string[] | undefined) ?? ["."];
			const consent = grammarConsent(ctx as ExecuteCtx);

			const files: string[] = [];
			for (const p of rawPaths) collectFiles(resolve(cwd, p), files);

			const diffs: string[] = [];
			const skippedLangs = new Set<string>();
			let changedFiles = 0;
			let totalEdits = 0;
			for (const file of files) {
				if (totalEdits >= MAX_LIMIT) break;
				const lang = forcedLang ?? languageForFile(file);
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
				const root = parsed.root;
				const matches = root.findAll(pattern);
				if (matches.length === 0) continue;
				const edits: SgEdit[] = matches.map((m) => m.replace(fillRewrite(m, rewrite)));
				const after = root.commitEdits(edits);
				if (after === source) continue;
				changedFiles++;
				totalEdits += edits.length;
				const rel = relative(cwd, file);
				diffs.push(summarizeChange(rel, source, after));
				if (apply) writeFileSync(file, after);
			}

			const skipNote =
				skippedLangs.size > 0 ? ` (skipped, no grammar: ${[...skippedLangs].join(", ")})` : "";
			const head = apply
				? `Applied ${totalEdits} edit(s) in ${changedFiles} file(s).${skipNote}`
				: `Preview: ${totalEdits} edit(s) in ${changedFiles} file(s). Set apply=true to write.${skipNote}`;
			const text = diffs.length > 0 ? `${head}\n\n${diffs.join("\n\n")}` : `No matches.${skipNote}`;
			return {
				content: [{ type: "text" as const, text }],
				details: {
					_type: "pixReplace",
					outcome: changedFiles > 0 ? "success" : "empty",
					applied: apply,
					edits: totalEdits,
					files: changedFiles,
				},
			};
		},
	});
}
