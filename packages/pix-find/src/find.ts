import { isAbsolute, relative, resolve } from "node:path";
import {
	formatCallTargets,
	resolveBatchStrings,
	runBatchTool,
	withOptionalStringArray,
} from "@xynogen/pix-pretty/batch";
import type { ToolContext } from "@xynogen/pix-pretty/context";
import { fadeRulePaint } from "@xynogen/pix-pretty/frame";
import { renderDimPreview, renderTitle } from "@xynogen/pix-pretty/render-row";
import { getTextContent, makeTextResult, setResultDetails } from "@xynogen/pix-pretty/result";
import { appendNotices, pluralize } from "@xynogen/pix-pretty/text";
import { toolCallRenderer, toolCardRenderer } from "@xynogen/pix-pretty/tool-card";
import type {
	FindParams,
	FindResultDetails,
	PiPrettyApi,
	ToolFactory,
	ToolResultLike,
} from "@xynogen/pix-pretty/types";
import { fillToolBackground } from "@xynogen/pix-pretty/utils";
import { topLevelDirs } from "@xynogen/pix-runtime/fs";
import type {
	AgentToolUpdateCallback,
	ExtensionContext,
	FindToolInput,
} from "@xynogen/pix-runtime/host";
import { isHomeOrFsRoot } from "@xynogen/pix-runtime/paths";

export const DEFAULT_FIND_LIMIT = 200;

const FILE_NOUNS = ["file", "files"] as const;

/** FindParams plus the optional batch `patterns` array (added to the schema at runtime). */
type FindBatchParams = FindParams & { patterns?: string[] };

export function applyFindDefaults(params: FindParams): FindParams {
	return params.limit === undefined ? { ...params, limit: DEFAULT_FIND_LIMIT } : params;
}

/**
 * Build a highlight regex from a glob pattern by keeping only its literal runs
 * (the wildcard-free fragments) as case-insensitive alternatives. `**​/*.test.ts`
 * → highlight `.test.ts`; `*.ts` → highlight `.ts`. A pattern with no literal
 * run (e.g. `*`) yields undefined — nothing meaningful to emphasize.
 */
export function globHighlight(pattern: string): RegExp | undefined {
	const literals = pattern
		.split(/[*?{}[\],/]+/) // split on glob metacharacters + path separators
		.filter((s) => s.length >= 2); // skip single chars/dots — too noisy
	if (literals.length === 0) return undefined;
	const alt = literals.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
	try {
		return new RegExp(alt, "gi");
	} catch {
		return undefined;
	}
}

/**
 * Map a find pattern to an FFF glob over the cwd-rooted index, with Pi's SDK find semantics:
 * a pattern with `/` is relative to the search folder; one without matches names at any depth.
 * `strip` turns an index path back into a search-folder-relative path. Undefined when the
 * search folder is outside the index, so the caller uses the SDK.
 */
export function fffGlobQuery(
	pattern: string,
	searchDir: string,
): { glob: string; strip: (indexPath: string) => string } | undefined {
	const base = searchDir.replaceAll("\\", "/");
	if (base.startsWith("..") || isAbsolute(base)) return undefined;
	const rel = pattern.replace(/^\.\//, "");
	const glob = rel.includes("/") ? rel : `**/${rel}`;
	const prefix = base ? `${base}/` : "";
	return {
		glob: `${prefix}${glob}`,
		strip: (indexPath) => {
			const p = indexPath.replaceAll("\\", "/");
			return p.startsWith(prefix) ? p.slice(prefix.length) : p;
		},
	};
}

export const TOP_LEVEL_NOTICE =
	"Home or filesystem root: top-level folders only. Pass one as `path` to search inside it.";

export function registerFindTool(
	pi: PiPrettyApi,
	createFindTool: ToolFactory<FindToolInput>,
	ctx: ToolContext,
): void {
	const { cwd, sp, TextComponent, fffState } = ctx;
	const origFind = createFindTool(cwd);

	pi.registerTool({
		...origFind,
		name: "find",
		description:
			"Find files by glob pattern. A pattern with `/` is relative to `path` (`src/*.ts` matches only that folder; use `**/src/*.ts` for any depth); one without `/` matches file names at any depth. Defaults to 200 paths; use limit to request more. Respects .gitignore and remains capped by Pi's 50KB hard limit. Pass `patterns` to search several known globs in one call.",
		parameters: withOptionalStringArray(
			origFind.parameters,
			"patterns",
			"Known glob patterns to search in one call (each capped, one combined result). Use instead of `pattern` for multiple known globs.",
			["pattern"],
		),
		renderShell: "self",

		async execute(
			tid: string,
			params: FindBatchParams,
			sig: AbortSignal | undefined,
			upd: AgentToolUpdateCallback<unknown> | undefined,
			toolCtx: ExtensionContext,
		) {
			// Search one glob (FFF-accelerated, SDK fallback) → structured find result.
			const runOne = async (
				pattern: string,
				callId: string,
			): Promise<ToolResultLike<FindResultDetails>> => {
				const { patterns: _patterns, ...rest } = params;
				const effectiveParams = applyFindDefaults({ ...rest, pattern });

				const root = resolve(cwd, effectiveParams.path ?? ".");
				if (isHomeOrFsRoot(root)) {
					const names = topLevelDirs(root, effectiveParams.limit ?? DEFAULT_FIND_LIMIT);
					const textContent = appendNotices(names.join("\n"), [TOP_LEVEL_NOTICE]);
					return makeTextResult<FindResultDetails>(textContent, {
						_type: "findResult",
						text: textContent,
						pattern,
						path: effectiveParams.path,
						matchCount: names.length,
					});
				}

				// Try FFF first: exact glob over the frecency index, matched like the SDK fallback.
				const finder = fffState.finder;
				const indexRoot = finder && !finder.isDestroyed ? finder.getBasePath() : undefined;
				const query =
					indexRoot?.ok && indexRoot.value
						? fffGlobQuery(effectiveParams.pattern, relative(indexRoot.value, root))
						: undefined;
				if (finder && query) {
					try {
						const effectiveLimit = Math.max(1, effectiveParams.limit ?? DEFAULT_FIND_LIMIT);
						const searchResult = finder.glob(query.glob, {
							pageSize: effectiveLimit,
						});
						if (searchResult.ok) {
							const { items, totalMatched } = searchResult.value;
							const trimmed = items.slice(0, effectiveLimit);
							const notices: string[] = [];
							if (fffState.partialIndex) notices.push("Warning: partial file index");
							if (trimmed.length >= effectiveLimit) notices.push(`${effectiveLimit} limit reached`);
							if (totalMatched > trimmed.length) notices.push(`${totalMatched} total matches`);

							const textContent = appendNotices(
								trimmed.map((item) => query.strip(item.relativePath)).join("\n"),
								notices,
							);
							return makeTextResult<FindResultDetails>(textContent, {
								_type: "findResult",
								text: textContent,
								pattern: effectiveParams.pattern,
								path: effectiveParams.path,
								matchCount: trimmed.length,
							});
						}
					} catch {
						/* fall through to SDK */
					}
				}

				// SDK fallback
				const result = await origFind.execute(callId, effectiveParams, sig, upd, toolCtx);
				const textContent = getTextContent(result);
				setResultDetails<FindResultDetails>(result, {
					_type: "findResult",
					text: textContent,
					pattern,
					path: effectiveParams.path,
					matchCount: textContent ? textContent.trim().split("\n").filter(Boolean).length : 0,
				});
				return result as ToolResultLike<FindResultDetails>;
			};

			const targets = resolveBatchStrings(params.pattern, params.patterns);
			if (targets.length === 0) {
				return makeTextResult<FindResultDetails>("pattern or patterns required", {
					_type: "findResult",
					text: "pattern or patterns required",
					pattern: "",
					path: params.path,
					matchCount: 0,
				});
			}

			const outcome = await runBatchTool<ToolResultLike>({
				targets,
				signal: sig,
				nouns: FILE_NOUNS,
				maxUnits: params.limit ?? DEFAULT_FIND_LIMIT,
				run: (pattern, i) => runOne(pattern, i === undefined ? tid : `${tid}:${i}`),
				singleError: (_pattern, text) => ({
					content: [{ type: "text" as const, text }],
					details: {
						_type: "findResult" as const,
						text,
						pattern: params.pattern ?? "",
						path: params.path,
						matchCount: 0,
					},
					isError: true,
				}),
				section: (result) => {
					const details = result.details as FindResultDetails | undefined;
					if (details?._type === "findResult")
						return { body: details.text, units: details.matchCount };
					const body = getTextContent(result);
					return { body, units: body.trim().split("\n").filter(Boolean).length };
				},
			});
			if ("single" in outcome) return outcome.single;
			const { text, full, units } = outcome.batch;
			return makeTextResult<FindResultDetails>(text, {
				_type: "findResult",
				text: full,
				pattern: outcome.batch.targets.join(", "),
				patterns: outcome.batch.targets,
				path: params.path,
				matchCount: units,
			});
		},

		renderCall: toolCallRenderer<FindBatchParams>(TextComponent, (args, theme, renderCtx) => {
			const batchPatterns = resolveBatchStrings(args.pattern, args.patterns);
			const pattern =
				batchPatterns.length > 1
					? formatCallTargets(batchPatterns, 3, "patterns")
					: (args.pattern ?? "");
			const path = args.path ? ` ${theme.fg("muted", `in ${sp(args.path)}`)}` : "";
			return fillToolBackground(
				`${renderTitle(theme, "find", renderCtx)} ${theme.fg("dim", pattern)}${path}`,
			);
		}),

		renderResult: toolCardRenderer<FindResultDetails>(TextComponent, {
			name: "find",
			owns: (d) => d?._type === "findResult",
			collapsed: (d) => ({
				summary:
					d?._type === "findResult" && d.matchCount != null
						? pluralize(d.matchCount, "file")
						: "found",
				target: d?._type === "findResult" ? `${d.pattern}${d.path ? ` in ${sp(d.path)}` : ""}` : "",
			}),
			body({ d, result, text, theme, ctx: renderCtx, isPartial }) {
				// One framed shape; rules follow status color. Count lives in the collapsed row.
				text.setText(
					renderDimPreview(getTextContent(result) || "found", theme, {
						frame: !isPartial,
						ctx: renderCtx,
						paint: fadeRulePaint(theme, "success"),
						highlight:
							d?._type === "findResult" && !d.patterns ? globHighlight(d.pattern) : undefined,
					}),
				);
				return "framed";
			},
		}),
	});
}
