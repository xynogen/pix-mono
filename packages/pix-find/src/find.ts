import type {
	ExtensionContext,
	FindToolInput,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { resolveBaseBackground } from "@xynogen/pix-pretty/ansi";
import {
	BATCH_MAX_BYTES,
	type BatchSection,
	capSections,
	formatBatchIndex,
	formatCallTargets,
	joinSectionBodies,
	resolveBatchStrings,
	sliceBatchTargets,
	withOptionalStringArray,
} from "@xynogen/pix-pretty/batch";
import type { ToolContext } from "@xynogen/pix-pretty/context";
import type {
	FindParams,
	FindResultDetails,
	PiPrettyApi,
	RenderContextLike,
	ThemeLike,
	ToolFactory,
	ToolResultLike,
} from "@xynogen/pix-pretty/types";
import {
	appendNotices,
	fillToolBackground,
	formatToolCallTitle,
	frameToolResult,
	getErrorMessage,
	getTextContent,
	hideCollapsedToolCall,
	makeTextResult,
	pluralize,
	renderCollapsedToolRow,
	renderDimPreview,
	renderToolError,
	setResultDetails,
	unframeToolResult,
} from "@xynogen/pix-pretty/utils";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";

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
			upd: unknown,
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
				const result = await origFind.execute(callId, effectiveParams, sig, upd as never, toolCtx);
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
			const settled = await Promise.all(
				targets.map(async (pattern, i) => {
					try {
						return { pattern, result: await runOne(pattern, `${tid}:${i}`) };
					} catch (error) {
						if (sig?.aborted) throw error;
						return { pattern, error: getErrorMessage(error) };
					}
				}),
			);
			const sections: BatchSection[] = settled.map((entry) => {
				if ("error" in entry && entry.error) {
					return { id: entry.pattern, body: "", units: 0, nouns: FILE_NOUNS, error: entry.error };
				}
				const details = (entry as { result: ToolResultLike<FindResultDetails> }).result.details;
				const body =
					details?._type === "findResult"
						? details.text
						: getTextContent((entry as { result: ToolResultLike }).result);
				const units =
					details?._type === "findResult"
						? details.matchCount
						: body.trim().split("\n").filter(Boolean).length;
				return { id: entry.pattern, body, units, nouns: FILE_NOUNS };
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

		renderCall(args: FindBatchParams, theme: ThemeLike, renderCtx: RenderContextLike) {
			resolveBaseBackground(theme);
			const batchPatterns = resolveBatchStrings(args.pattern, args.patterns);
			const pattern =
				batchPatterns.length > 1
					? formatCallTargets(batchPatterns, 3, "patterns")
					: (args.pattern ?? "");
			const path = args.path ? ` ${theme.fg("muted", `in ${sp(args.path)}`)}` : "";
			const text = renderCtx.lastComponent ?? new TextComponent("", 0, 0);
			if (
				hideCollapsedToolCall(renderCtx.state as CollapseState, renderCtx.expanded, (value) =>
					text.setText(value),
				)
			)
				return text;
			text.setText(
				fillToolBackground(
					`${formatToolCallTitle(theme, "find", renderCtx)} ${theme.fg("dim", pattern)}${path}`,
				),
			);
			return text;
		},

		renderResult(
			result: ToolResultLike<FindResultDetails>,
			_opt: ToolRenderResultOptions,
			theme: ThemeLike,
			renderCtx: RenderContextLike,
		) {
			resolveBaseBackground(theme);
			const text = unframeToolResult(renderCtx.lastComponent ?? new TextComponent("", 0, 0));
			const d = result.details;
			const isPartial = _opt?.isPartial === true;
			const completed = () => frameToolResult(text, theme, renderCtx.isError);
			const structuredError = renderCtx.isError && d?._type === "findResult";

			if (renderCtx.isError && (!structuredError || isPartial)) {
				text.setText(renderToolError(getTextContent(result) || "Error", theme));
				return isPartial ? text : completed();
			}

			// Auto-collapse: show summary line after delay
			const cs = renderCtx.state as CollapseState;
			if (!isPartial && tickCollapse("find", cs, renderCtx.invalidate, renderCtx.expanded)) {
				const summary =
					d?._type === "findResult" && d.matchCount != null
						? pluralize(d.matchCount, "file")
						: "found";
				const target = d?._type === "findResult" ? d.pattern : "";
				const scope = d?._type === "findResult" && d.path ? ` in ${sp(d.path)}` : "";
				text.setText(
					renderCollapsedToolRow(
						theme,
						"find",
						`${target}${scope}`,
						renderCtx.isError ? "failed" : summary,
						renderCtx.isError ? "error" : "success",
					),
				);
				return text;
			}

			if (renderCtx.isError) {
				text.setText(renderToolError(getTextContent(result) || "Error", theme));
				return completed();
			}

			const output = getTextContent(result) || "found";
			// One framed shape; rules follow status color. Count lives in the collapsed row.
			text.setText(
				renderDimPreview(output, theme, {
					frame: !isPartial,
					paint: (s: string) => theme.fg(renderCtx.isError ? "error" : "success", s),
					highlight:
						d?._type === "findResult" && !d.patterns ? globHighlight(d.pattern) : undefined,
				}),
			);
			return text;
		},
	});
}
