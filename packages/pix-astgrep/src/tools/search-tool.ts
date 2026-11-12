/**
 * search-tool.ts — the `ast` tool's `search` action.
 *
 * AST-aware structural search. The agent gives an ast-grep pattern and a
 * language (or lets the tool infer it per file). The tool walks explicit paths
 * or files, parses each supported file, and returns match locations with the
 * matched text. Unsupported languages are skipped with a clear note.
 */

import { relative, resolve } from "node:path";
import { StringEnum } from "@xynogen/pix-data/ai";
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
import {
	ALL_LANGUAGES,
	type AnyLanguage,
	languageForFile,
	parseWithGrammar,
} from "@xynogen/pix-runtime/ast";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";
import { readFileSync } from "@xynogen/pix-runtime/fs";
import { defineTool } from "@xynogen/pix-runtime/host";
import { Type } from "typebox";
import { collectCodeFiles } from "../files.ts";
import { grammarErrorResult } from "../grammar-result.ts";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

export interface SearchToolDeps {
	cwd: string;
}

interface Match {
	file: string;
	line: number;
	column: number;
	text: string;
}

export function searchTool(deps: SearchToolDeps) {
	const { cwd } = deps;

	return defineTool({
		name: "search",
		label: "AST search",
		description:
			"Structural search ($A, $$$ARGS). Paths default to cwd; lang defaults to file extension. Extra grammars require consent; newly installed grammars may need an agent restart.",
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
			paths: Type.Optional(Type.Array(Type.String(), { description: "Files/dirs; default cwd." })),
			lang: Type.Optional(
				StringEnum([...ALL_LANGUAGES], {
					description: "Override file-extension language.",
				}),
			),
			limit: Type.Optional(
				Type.Integer({ minimum: 1, maximum: MAX_LIMIT, description: "Max matches (default 100)." }),
			),
		}),

		renderCall(args, theme, context) {
			if (hideCollapsedToolCall(context.state as CollapseState, context.expanded, () => {}))
				return new Text("", 0, 0);
			const t = theme as Theme;
			const a = args as { pattern?: string; lang?: string };
			const title = renderTitle(t, "ast", context, "search");
			const pat = t.fg("dim", a.pattern ?? "");
			const lang = a.lang ? t.fg("muted", ` · ${a.lang}`) : "";
			return new Text(`${title} ${pat}${lang}`.trimEnd(), 0, 0);
		},

		renderResult(result, options, theme, context) {
			const t = theme as Theme;
			const text = result.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
			const details = result.details as { outcome?: string } | undefined;
			const isError = context.isError || details?.outcome === "error";
			if (
				!options.isPartial &&
				tickCollapse("ast", context.state as CollapseState, context.invalidate, options.expanded)
			)
				return new Text(
					renderRow(
						theme,
						"ast · search",
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
			const pattern = params.pattern as string | { context: string; selector: string };
			const forcedLang = params.lang as AnyLanguage | undefined;
			const limit = Math.min(MAX_LIMIT, (params.limit as number | undefined) ?? DEFAULT_LIMIT);
			const rawPaths = (params.paths as string[] | undefined) ?? ["."];
			const consent = grammarConsent(ctx as ExecuteCtx, signal);

			const files: string[] = [];
			for (const p of rawPaths) await collectCodeFiles(resolve(cwd, p), files, 5000, signal);

			const matches: Match[] = [];

			let scanned = 0;
			for (const file of files) {
				await cancellationCheckpoint(signal);
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
				const parsed = await abortable(parseWithGrammar(lang, source, consent, signal), signal);
				signal?.throwIfAborted();
				if (parsed.kind !== "ok") {
					return grammarErrorResult(parsed, lang, "pixAstGrep");
				}
				for (const node of parsed.root.findAll(
					typeof pattern === "string" ? pattern : { rule: { pattern } },
				)) {
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
			const text = lines.length > 0 ? lines.join("\n") : `No matches in ${scanned} file(s).`;

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
