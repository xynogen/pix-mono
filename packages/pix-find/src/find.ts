import {
	BATCH_MAX_BYTES,
	type BatchSection,
	capSections,
	formatBatchIndex,
	formatCallTargets,
	joinSectionBodies,
	resolveBatchStrings,
	runBatch,
	sliceBatchTargets,
	withOptionalStringArray,
} from "@xynogen/pix-pretty/batch";
import type { ToolContext } from "@xynogen/pix-pretty/context";
import { toolCallRenderer, toolCardRenderer } from "@xynogen/pix-pretty/tool-card";
import type {
	FindParams,
	FindResultDetails,
	PiPrettyApi,
	ToolFactory,
	ToolResultLike,
} from "@xynogen/pix-pretty/types";
import {
	appendNotices,
	fadeRulePaint,
	fillToolBackground,
	getErrorMessage,
	getTextContent,
	makeTextResult,
	pluralize,
	renderDimPreview,
	renderTitle,
	setResultDetails,
} from "@xynogen/pix-pretty/utils";
import type {
	AgentToolUpdateCallback,
	ExtensionContext,
	FindToolInput,
} from "@xynogen/pix-runtime/host";

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
			"Find files by glob pattern. Defaults to 200 paths; use limit to request more. Respects .gitignore and remains capped by Pi's 50KB hard limit. Pass `patterns` to search several known globs in one call.",
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

				// Try FFF first (frecency-ranked, SIMD-accelerated)
				if (fffState.finder && !fffState.finder.isDestroyed) {
					try {
						const effectiveLimit = Math.max(1, effectiveParams.limit ?? DEFAULT_FIND_LIMIT);
						let query = effectiveParams.pattern;
						if (effectiveParams.path) query = `${effectiveParams.path} ${query}`;

						const searchResult = fffState.finder.fileSearch(query, {
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
								trimmed.map((item) => item.relativePath).join("\n"),
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

			const { targets, omitted } = sliceBatchTargets(
				resolveBatchStrings(params.pattern, params.patterns),
			);
			if (targets.length === 0) {
				return makeTextResult<FindResultDetails>("pattern or patterns required", {
					_type: "findResult",
					text: "pattern or patterns required",
					pattern: "",
					path: params.path,
					matchCount: 0,
				});
			}

			// Single glob → preserve the original single-search result shape.
			if (targets.length === 1 && omitted === 0) {
				try {
					return await runOne(targets[0] ?? "", tid);
				} catch (error) {
					const text = getErrorMessage(error);
					if (sig?.aborted || /aborted/i.test(text)) throw error;
					return {
						content: [{ type: "text" as const, text }],
						details: {
							_type: "findResult" as const,
							text,
							pattern: params.pattern ?? "",
							path: params.path,
							matchCount: 0,
						},
						isError: true,
					};
				}
			}

			// Batch: search every glob in parallel, cap the combined output.
			const settled = await runBatch(
				targets,
				(pattern, i) => runOne(pattern, `${tid}:${i}`),
				sig,
				getErrorMessage,
			);
			const sections: BatchSection[] = settled.map((entry) => {
				if ("error" in entry) {
					return { id: entry.target, body: "", units: 0, nouns: FILE_NOUNS, error: entry.error };
				}
				const details = entry.result.details;
				const body = details?._type === "findResult" ? details.text : getTextContent(entry.result);
				const units =
					details?._type === "findResult"
						? details.matchCount
						: body.trim().split("\n").filter(Boolean).length;
				return { id: entry.target, body, units, nouns: FILE_NOUNS };
			});
			const { text } = capSections(
				sections,
				BATCH_MAX_BYTES,
				params.limit ?? DEFAULT_FIND_LIMIT,
				omitted,
			);
			const matchCount = sections.reduce((sum, s) => sum + (s.error ? 0 : s.units), 0);
			const full = [formatBatchIndex(sections, omitted), joinSectionBodies(sections)]
				.filter(Boolean)
				.join("\n\n");
			return makeTextResult<FindResultDetails>(text, {
				_type: "findResult",
				text: full,
				pattern: targets.join(", "),
				patterns: targets,
				path: params.path,
				matchCount,
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
