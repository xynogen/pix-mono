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
	getTextContent,
	hideCollapsedToolCall,
	makeTextResult,
	pluralize,
	renderCollapsedToolRow,
	renderDimPreview,
	renderToolError,
	setResultDetails,
} from "@xynogen/pix-pretty/utils";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";

export const DEFAULT_FIND_LIMIT = 200;

export function applyFindDefaults(params: FindParams): FindParams {
	return params.limit === undefined ? { ...params, limit: DEFAULT_FIND_LIMIT } : params;
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
					`${theme.fg("toolTitle", theme.bold("find"))} ${theme.fg("accent", pattern)}${path}`,
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
			const text = renderCtx.lastComponent ?? new TextComponent("", 0, 0);
			const d = result.details;
			const isPartial = _opt?.isPartial === true;
			const structuredError = renderCtx.isError && d?._type === "findResult";

			if (renderCtx.isError && (!structuredError || isPartial)) {
				text.setText(renderToolError(getTextContent(result) || "Error", theme));
				return text;
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
				return text;
			}

			const output = getTextContent(result) || "found";
			text.setText(
				renderDimPreview(output, theme, {
					frame: true,
					// Same semantic count the collapsed row shows — one source, no drift.
					header:
						d?._type === "findResult" && d.matchCount != null
							? pluralize(d.matchCount, "file")
							: undefined,
				}),
			);
			return text;
		},
	});
}
