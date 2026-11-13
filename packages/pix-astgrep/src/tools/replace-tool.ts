/**
 * replace-tool.ts — the `ast` tool's `replace` action.
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

import { relative, resolve } from "node:path";
import { StringEnum } from "@xynogen/pix-data/ai";
import { parseDiff } from "@xynogen/pix-pretty/diff";
import { type ExecuteCtx, grammarConsent } from "@xynogen/pix-pretty/grammar-consent";
import { abortable, cancellationCheckpoint } from "@xynogen/pix-runtime/abort";
import {
	ALL_LANGUAGES,
	type AnyLanguage,
	languageForFile,
	parseWithGrammar,
	type SgEdit,
	type SgNode,
} from "@xynogen/pix-runtime/ast";
import { writeFileAtomicSync } from "@xynogen/pix-runtime/atomic-write";
import { readFileSync, statSync } from "@xynogen/pix-runtime/fs";
import { defineTool } from "@xynogen/pix-runtime/host";
import { Type } from "typebox";
import { collectCodeFiles } from "../files.ts";
import { grammarErrorResult } from "../grammar-result.ts";
import { astCall, astResult } from "../render.ts";

const MAX_LIMIT = 500;

export interface ReplaceToolDeps {
	cwd: string;
}

/**
 * Resolve $A and $$$ARGS tokens in `rewrite` from one match's captures.
 * One pass: captured text that itself contains `$NAME` is inserted verbatim,
 * never substituted again.
 */
function fillRewrite(match: SgNode, rewrite: string): string {
	return rewrite.replace(
		/\$(\$\$)?([A-Z_][A-Z0-9_]*)/g,
		(token, multi: string | undefined, name: string) => {
			if (multi) {
				return match
					.getMultipleMatches(name)
					.map((n) => n.text())
					.join(", ");
			}
			return match.getMatch(name)?.text() ?? token;
		},
	);
}

/** Changed lines with 1 line of context; a real line diff, so an insert shifts nothing. */
function summarizeChange(rel: string, before: string, after: string): string {
	const out: string[] = [`--- ${rel}`, `+++ ${rel}`];
	for (const line of parseDiff(before, after, 1).lines) {
		if (line.type === "sep") out.push("…");
		else if (line.type === "add") out.push(`+${line.newNum}: ${line.content}`);
		else if (line.type === "del") out.push(`-${line.oldNum}: ${line.content}`);
		else out.push(` ${line.newNum}: ${line.content}`);
	}
	return out.join("\n");
}

export function replaceTool(deps: ReplaceToolDeps) {
	const { cwd } = deps;

	return defineTool({
		name: "replace",
		label: "AST replace",
		description:
			"Structural replace ($A, $$$ARGS). Preview only unless apply=true. Extra grammars require consent; newly installed grammars may need an agent restart.",
		parameters: Type.Object({
			pattern: Type.Union([
				Type.String({ description: "Pattern, e.g. foo($A)." }),
				Type.Object(
					{ context: Type.String(), selector: Type.String() },
					{
						description:
							"Fragment in context; selector is its AST kind (PHP: context='<?php 123;', selector='integer').",
					},
				),
			]),
			rewrite: Type.String({ description: "Replacement, e.g. `bar($A)`." }),
			paths: Type.Optional(Type.Array(Type.String(), { description: "Files/dirs; default cwd." })),
			lang: Type.Optional(
				StringEnum([...ALL_LANGUAGES], {
					description: "Override file-extension language.",
				}),
			),
			apply: Type.Optional(
				Type.Boolean({ description: "Write the files. Default false (preview only)." }),
			),
		}),

		renderCall: astCall<{ pattern?: string; rewrite?: string; apply?: boolean }>(
			"replace",
			(a, t) =>
				t.fg("dim", `${a.pattern ?? ""} → ${a.rewrite ?? ""}`) +
				t.fg("muted", a.apply ? " · apply" : " · preview"),
		),
		renderResult: astResult("replace"),

		async execute(_id, params, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			const pattern = params.pattern as string | { context: string; selector: string };
			const rewrite = params.rewrite as string;
			const apply = (params.apply as boolean | undefined) ?? false;
			const forcedLang = params.lang as AnyLanguage | undefined;
			const rawPaths = (params.paths as string[] | undefined) ?? ["."];
			const consent = grammarConsent(ctx as ExecuteCtx, signal);

			const files: string[] = [];
			for (const p of rawPaths) await collectCodeFiles(resolve(cwd, p), files, 5000, signal);

			const diffs: string[] = [];
			const changes: Array<{ file: string; after: string }> = [];

			let changedFiles = 0;
			let totalEdits = 0;
			for (const file of files) {
				await cancellationCheckpoint(signal);
				if (totalEdits >= MAX_LIMIT) break;
				const lang = forcedLang ?? languageForFile(file);
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
					return grammarErrorResult(parsed, lang, "pixReplace");
				}
				const root = parsed.root;
				const matches = root.findAll(typeof pattern === "string" ? pattern : { rule: { pattern } });
				if (matches.length === 0) continue;
				const edits: SgEdit[] = matches.map((m) => m.replace(fillRewrite(m, rewrite)));
				const after = root.commitEdits(edits);
				if (after === source) continue;
				changedFiles++;
				totalEdits += edits.length;
				const rel = relative(cwd, file);
				diffs.push(summarizeChange(rel, source, after));
				changes.push({ file, after });
			}

			// Validate all grammars before writing, so an unavailable language cannot leave partial edits.
			// Atomic per file and keep the file's permissions (the helper defaults to 0o600).
			await cancellationCheckpoint(signal);
			if (apply) {
				for (const { file, after } of changes) {
					signal?.throwIfAborted();
					writeFileAtomicSync(file, after, statSync(file).mode & 0o777);
				}
			}
			const head = apply
				? `Applied ${totalEdits} edit(s) in ${changedFiles} file(s).`
				: `Preview: ${totalEdits} edit(s) in ${changedFiles} file(s). Set apply=true to write.`;
			const text = diffs.length > 0 ? `${head}\n\n${diffs.join("\n\n")}` : "No matches.";
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
