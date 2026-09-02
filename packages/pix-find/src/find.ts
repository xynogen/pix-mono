import type {
	ExtensionContext,
	FindToolInput,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { resolveBaseBackground } from "@xynogen/pix-pretty/ansi";
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
	frameToolResult,
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
			"Find files by glob pattern. Defaults to 200 paths; use limit to request more. Respects .gitignore and remains capped by Pi's 50KB hard limit.",
		renderShell: "self",

		async execute(
			tid: string,
			params: FindParams,
			sig: AbortSignal | undefined,
			upd: unknown,
			toolCtx: ExtensionContext,
		) {
			const effectiveParams = applyFindDefaults(params);

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
			try {
				const result = await origFind.execute(tid, effectiveParams, sig, upd as never, toolCtx);
				const textContent = getTextContent(result);
				const matchCount = textContent ? textContent.trim().split("\n").filter(Boolean).length : 0;

				setResultDetails<FindResultDetails>(result, {
					_type: "findResult",
					text: textContent,
					pattern: params.pattern,
					path: params.path,
					matchCount,
				});

				return result;
			} catch (error) {
				const text = error instanceof Error ? error.message : String(error);
				if (sig?.aborted || /aborted/i.test(text)) throw error;
				return {
					content: [{ type: "text" as const, text }],
					details: {
						_type: "findResult" as const,
						text,
						pattern: params.pattern,
						path: params.path,
						matchCount: 0,
					},
					isError: true,
				};
			}
		},

		renderCall(args: FindParams, theme: ThemeLike, renderCtx: RenderContextLike) {
			resolveBaseBackground(theme);
			const pattern = args.pattern ?? "";
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
					`${theme.fg("toolTitle", theme.bold("find"))} ${theme.fg("dim", pattern)}${path}`,
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
					highlight: d?._type === "findResult" ? globHighlight(d.pattern) : undefined,
				}),
			);
			return text;
		},
	});
}
