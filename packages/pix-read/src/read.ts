import type {
	AgentToolUpdateCallback,
	ExtensionContext,
	ReadToolInput,
} from "@earendil-works/pi-coding-agent";
import { resolveBaseBackground } from "@xynogen/pix-pretty/ansi";
import { MAX_PREVIEW_LINES } from "@xynogen/pix-pretty/config";
import type { ToolContext } from "@xynogen/pix-pretty/context";
import { fileIcon } from "@xynogen/pix-pretty/icons";
import { renderFileContent } from "@xynogen/pix-pretty/renderers";
import type {
	PiPrettyApi,
	ReadParams,
	RenderContextLike,
	ThemeLike,
	ToolFactory,
	ToolResultLike,
} from "@xynogen/pix-pretty/types";
import {
	dotJoin,
	fillToolBackground,
	getTextContent,
	hideCollapsedToolCall,
	humanSize,
	isImageContent,
	isTextContent,
	normalizeLineEndings,
	renderCollapsedToolRow,
	renderToolError,
	ruleFrame,
	setResultDetails,
} from "@xynogen/pix-pretty/utils";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";

export const DEFAULT_READ_LIMIT = 400;

export function applyReadDefaults(params: ReadParams): ReadParams {
	return params.limit === undefined ? { ...params, limit: DEFAULT_READ_LIMIT } : params;
}

export function registerReadTool(
	pi: PiPrettyApi,
	createReadTool: ToolFactory<ReadToolInput>,
	ctx: ToolContext,
): void {
	const { cwd, sp, TextComponent } = ctx;
	const origRead = createReadTool(cwd);

	pi.registerTool({
		...origRead,
		name: "read",
		description:
			"Read text files and images. Text reads default to 400 lines and remain capped by Pi's 2,000-line/50KB hard limit. Use offset/limit to continue large files.",
		// Full-width framing baked at termW(); default Box shell pads x by 1
		// and re-wraps at width-2, splitting every line into a padding row.
		renderShell: "self",

		async execute(
			tid: string,
			params: ReadParams,
			sig: AbortSignal | undefined,
			upd: AgentToolUpdateCallback<unknown> | undefined,
			toolCtx: ExtensionContext,
		) {
			const effectiveParams = applyReadDefaults(params);
			const fp = effectiveParams.path ?? "";
			const offset = effectiveParams.offset ?? 1;
			try {
				const result = (await origRead.execute(
					tid,
					effectiveParams,
					sig,
					upd,
					toolCtx,
				)) as ToolResultLike;

				const imageBlock = result.content?.find(isImageContent);
				if (imageBlock) {
					setResultDetails(result, {
						_type: "readImage",
						filePath: fp,
						data: imageBlock.data,
						mimeType: imageBlock.mimeType ?? "image/png",
					});
					return result;
				}

				const textContent = getTextContent(result);
				if (textContent && fp) {
					const normalizedContent = normalizeLineEndings(textContent);
					const lineCount = normalizedContent.split("\n").length;
					setResultDetails(result, {
						_type: "readFile",
						filePath: fp,
						content: normalizedContent,
						offset,
						lineCount,
					});
				}

				return result;
			} catch (error) {
				const text = error instanceof Error ? error.message : String(error);
				if (sig?.aborted || /aborted/i.test(text)) throw error;
				return {
					content: [{ type: "text" as const, text }],
					details: {
						_type: "readFile" as const,
						filePath: fp,
						content: text,
						offset,
						lineCount: 1,
					},
					isError: true,
				};
			}
		},

		renderCall(args: ReadParams, theme: ThemeLike, renderCtx: RenderContextLike) {
			resolveBaseBackground(theme);
			const fp = args.path ?? "";
			const text = renderCtx.lastComponent ?? new TextComponent("", 0, 0);
			if (
				hideCollapsedToolCall(renderCtx.state as CollapseState, renderCtx.expanded, (value) =>
					text.setText(value),
				)
			)
				return text;
			const offset = args.offset ? ` ${theme.fg("muted", `from line ${args.offset}`)}` : "";
			const limit = args.limit ? ` ${theme.fg("muted", `(${args.limit} lines)`)}` : "";
			text.setText(
				fillToolBackground(
					`${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", sp(fp))}${offset}${limit}`,
				),
			);
			return text;
		},

		renderResult(
			result: ToolResultLike,
			_opt: unknown,
			theme: ThemeLike,
			renderCtx: RenderContextLike,
		) {
			resolveBaseBackground(theme);
			const text = renderCtx.lastComponent ?? new TextComponent("", 0, 0);
			const d = result.details as Record<string, unknown> | undefined;
			const isPartial = (_opt as { isPartial?: boolean } | undefined)?.isPartial === true;
			const structuredError =
				renderCtx.isError && (d?._type === "readFile" || d?._type === "readImage");

			if (renderCtx.isError && (!structuredError || isPartial)) {
				text.setText(renderToolError(getTextContent(result) || "Error", theme));
				return text;
			}

			// Auto-collapse: show summary line after delay
			const cs = renderCtx.state as CollapseState;
			if (!isPartial && tickCollapse("read", cs, renderCtx.invalidate, renderCtx.expanded)) {
				if (renderCtx.isError) {
					text.setText(
						renderCollapsedToolRow(theme, "read", sp(String(d?.filePath ?? "")), "failed", "error"),
					);
				} else if (d?._type === "readFile") {
					text.setText(
						renderCollapsedToolRow(
							theme,
							"read",
							sp(String(d.filePath ?? "")),
							`${d.lineCount} lines`,
						),
					);
				} else if (d?._type === "readImage") {
					const byteSize = Math.ceil(((d.data as string).length * 3) / 4);
					text.setText(
						renderCollapsedToolRow(
							theme,
							"read",
							sp(String(d.filePath ?? "")),
							dotJoin([String(d.mimeType ?? "image"), humanSize(byteSize)]),
						),
					);
				} else {
					text.setText(renderCollapsedToolRow(theme, "read", "", "done"));
				}
				return text;
			}

			if (renderCtx.isError) {
				text.setText(renderToolError(getTextContent(result) || "Error", theme));
				return text;
			}

			if (d?._type === "readImage") {
				const byteSize = Math.ceil(((d.data as string).length * 3) / 4);
				text.setText(
					fillToolBackground(
						`  ${fileIcon(d.filePath as string, theme)}${theme.fg("dim", dotJoin([String(d.mimeType ?? "image"), humanSize(byteSize)]))}`,
					),
				);
				return text;
			}

			if (d?._type === "readFile" && d.content) {
				const key = `read:${d.filePath}:${d.offset}:${d.lineCount}:${process.stdout.columns ?? 80}:${renderCtx.expanded ? "full" : "preview"}`;
				// One framed shape; rules follow status color. The line count lives in the
				// collapsed row — no floating "N lines" header above the frame.
				const paint = (s: string) => theme.fg("success", s);
				if (renderCtx.state._rk !== key) {
					renderCtx.state._rk = key;
					renderCtx.state._rt = fillToolBackground(theme.fg("muted", "  reading…"));

					const maxShow = renderCtx.expanded ? (d.lineCount as number) : MAX_PREVIEW_LINES;
					renderFileContent(
						d.content as string,
						d.filePath as string,
						d.offset as number,
						maxShow,
						theme,
					)
						.then((rendered: string) => {
							if (renderCtx.state._rk !== key) return;
							renderCtx.state._rt = fillToolBackground(
								ruleFrame(rendered.split("\n"), [], undefined, paint).join("\n"),
							);
							renderCtx.invalidate();
						})
						.catch(() => {});
				}
				text.setText(renderCtx.state._rt ?? fillToolBackground(theme.fg("muted", "  reading…")));
				return text;
			}

			const fallback = result.content?.[0];
			const fallbackText = fallback && isTextContent(fallback) ? fallback.text : "read";
			text.setText(fillToolBackground(`  ${theme.fg("dim", String(fallbackText).slice(0, 120))}`));
			return text;
		},
	});
}
