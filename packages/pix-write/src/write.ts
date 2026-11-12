import { MAX_RENDER_LINES } from "@xynogen/pix-pretty/config";
import type { ToolContext } from "@xynogen/pix-pretty/context";
import { parseDiff } from "@xynogen/pix-pretty/diff";
import {
	diffThemeCacheKey,
	renderSplit,
	resolveDiffColors,
	summarize,
} from "@xynogen/pix-pretty/diff-render";
import { lang } from "@xynogen/pix-pretty/lang";
import { renderFileContent } from "@xynogen/pix-pretty/renderers";
import { toolCallRenderer, toolCardRenderer } from "@xynogen/pix-pretty/tool-card";
import type {
	PiPrettyApi,
	ToolFactory,
	ToolResultLike,
	WriteParams,
	WriteRenderState,
} from "@xynogen/pix-pretty/types";
import {
	BODY_PAD,
	fillToolBackground,
	getErrorMessage,
	isTextContent,
	renderTitle,
	setResultDetails,
	termW,
} from "@xynogen/pix-pretty/utils";
import { editPath, writeText } from "@xynogen/pix-runtime/files";
import { existsSync, readFileSync } from "@xynogen/pix-runtime/fs";
import type {
	AgentToolUpdateCallback,
	ExtensionContext,
	WriteToolInput,
} from "@xynogen/pix-runtime/host";

/** Collapsed preview height for a new file; expanded shows every line. */
const NEW_FILE_PREVIEW_LINES = 12;
/** Streaming create-call preview height; expanded shows every line. */
const CREATE_PREVIEW_LINES = 16;

export function registerWriteTool(
	pi: PiPrettyApi,
	createWriteTool: ToolFactory<WriteToolInput>,
	ctx: ToolContext,
	trackInvalidator: (id: string, inv: () => void) => void,
): void {
	const { cwd, sp, TextComponent } = ctx;
	const origWrite = createWriteTool(cwd);

	pi.registerTool({
		...origWrite,
		name: "write",
		renderShell: "self",

		async execute(
			_tid: string,
			params: WriteParams,
			sig: AbortSignal | undefined,
			_upd: AgentToolUpdateCallback<unknown> | undefined,
			toolCtx: ExtensionContext,
		) {
			const fp = params.path ?? params.file_path ?? "";
			const content = params.content ?? "";
			let old: string | null = null;
			try {
				if (fp && existsSync(fp)) old = readFileSync(fp, "utf-8");
			} catch {
				old = null;
			}

			let result: ToolResultLike;
			try {
				if (!fp || typeof params.content !== "string")
					throw new Error("path and content are required");
				await writeText(editPath(fp, toolCtx?.cwd || cwd), content, undefined, sig);
				result = {
					content: [{ type: "text", text: `Successfully wrote to ${fp}` }],
					details: undefined,
				};
			} catch (error) {
				const text = getErrorMessage(error);
				if (sig?.aborted || /aborted/i.test(text)) throw error;
				return {
					content: [{ type: "text" as const, text }],
					details: {
						_type: "new" as const,
						lines: content.split("\n").length,
						content,
						filePath: fp,
					},
					isError: true,
				};
			}

			if (old !== null && old !== content) {
				const diff = parseDiff(old, content);
				setResultDetails(result, {
					_type: "diff",
					filePath: fp,
					summary: summarize(diff.added, diff.removed),
					oldContent: old,
					newContent: content,
					language: lang(fp),
				});
			} else if (old === null) {
				setResultDetails(result, {
					_type: "new",
					lines: content ? content.split("\n").length : 0,
					content,
					filePath: fp,
				});
			} else {
				setResultDetails(result, { _type: "noChange", filePath: fp });
			}
			return result;
		},

		renderCall: toolCallRenderer<WriteParams, WriteRenderState>(
			TextComponent,
			(args, theme, renderCtx) => {
				const fp = args?.path ?? args?.file_path ?? "";
				const isNew = !fp || !existsSync(fp);
				const label = isNew ? "create" : "write";
				const hdr = `${renderTitle(theme, label, renderCtx)} ${theme.fg("dim", sp(fp))}`;

				if (args?.content && isNew) {
					const previewKey = `create:${diffThemeCacheKey(theme)}:${fp}:${String(args.content).length}:${renderCtx.expanded ? "full" : "preview"}`;
					if (renderCtx.state._previewKey !== previewKey) {
						renderCtx.state._previewKey = previewKey;
						// Keep the previous body until the new highlight lands. Dropping to the bare
						// header shrinks the card on every streamed chunk, and once its top has
						// scrolled off-screen pi-tui must clear and repaint the whole terminal.
						const lines = String(args.content).split("\n").length;
						renderFileContent(
							String(args.content),
							fp,
							1,
							renderCtx.expanded ? lines : CREATE_PREVIEW_LINES,
							theme,
							{ wrapLongLines: renderCtx.expanded, ctx: renderCtx },
						)
							.then((rendered) => {
								if (renderCtx.state._previewKey !== previewKey) return;
								const body = `\n\n${rendered}`;
								renderCtx.state._previewText = body;
								renderCtx.invalidate();
							})
							.catch(() => {});
					}
					// The body is stored apart from the header so a changed header never pairs with stale text.
					return hdr + (renderCtx.state._previewText ?? "");
				}

				return fillToolBackground(hdr);
			},
		),

		renderResult: toolCardRenderer<Record<string, unknown>, WriteRenderState>(TextComponent, {
			name: "write",
			owns: (d) => d?._type === "diff" || d?._type === "new" || d?._type === "noChange",
			collapsed(d) {
				let summary = "written";
				if (d?._type === "diff") summary = String(d.summary);
				else if (d?._type === "noChange") summary = "no changes";
				else if (d?._type === "new") summary = `new file · ${d.lines} lines`;
				return { target: sp(String(d?.filePath ?? "")), summary };
			},
			body({ d, result, text, theme, ctx: renderCtx }) {
				if (d?._type === "diff") {
					const key = `wd:${diffThemeCacheKey(theme)}:${termW()}:${d.summary}:${(d.newContent as string).length}:${d.language ?? ""}`;
					if (renderCtx.toolCallId) trackInvalidator(renderCtx.toolCallId, renderCtx.invalidate);
					// No summary header above the diff — the collapsed row carries `+x -y`
					// (matches edit). The diff itself is the body.
					if (renderCtx.state._wdk !== key) {
						renderCtx.state._wdk = key;
						renderCtx.state._wdt = theme.fg("muted", "  rendering diff…");
						const dc = resolveDiffColors(theme);
						const diff = parseDiff(d.oldContent as string, d.newContent as string);
						renderSplit(diff, d.language as string | undefined, MAX_RENDER_LINES, dc)
							.then((rendered) => {
								if (renderCtx.state._wdk !== key) return;
								renderCtx.state._wdt = rendered;
								renderCtx.invalidate();
							})
							.catch(() => {
								if (renderCtx.state._wdk !== key) return;
								renderCtx.state._wdt = `${BODY_PAD}${d.summary}`;
								renderCtx.invalidate();
							});
					}
					text.setText(renderCtx.state._wdt ?? `${BODY_PAD}${d.summary}`);
					return undefined;
				}

				if (d?._type === "noChange") {
					text.setText(fillToolBackground(`${BODY_PAD}${theme.fg("muted", "✓ no changes")}`));
					return undefined;
				}

				if (d?._type === "new") {
					const {
						lines: lineCount,
						content: rawContent,
						filePath: fp,
					} = d as { lines: number; content: string; filePath: string };
					const base = `${BODY_PAD}${theme.fg("success", `✓ new file (${lineCount} lines)`)}`;
					const pk = `nf:${diffThemeCacheKey(theme)}:${fp}:${lineCount}:${renderCtx.expanded ? "full" : "preview"}`;
					if (renderCtx.state._nfk !== pk) {
						renderCtx.state._nfk = pk;
						renderCtx.state._nft = base;
						if (rawContent) {
							// Same gutter as read/edit: line numbers, wrapped long lines when expanded.
							renderFileContent(
								rawContent,
								fp,
								1,
								renderCtx.expanded ? lineCount : NEW_FILE_PREVIEW_LINES,
								theme,
								{ wrapLongLines: renderCtx.expanded, ctx: renderCtx },
							)
								.then((rendered) => {
									if (renderCtx.state._nfk !== pk) return;
									renderCtx.state._nft = fillToolBackground(`${base}\n${rendered}`);
									renderCtx.invalidate();
								})
								.catch(() => {});
						}
					}
					text.setText(renderCtx.state._nft ?? base);
					return undefined;
				}

				const fallback = result.content?.[0];
				const fallbackText = fallback && isTextContent(fallback) ? fallback.text : "written";
				text.setText(
					fillToolBackground(`${BODY_PAD}${theme.fg("dim", String(fallbackText).slice(0, 120))}`),
				);
				return undefined;
			},
		}),
	});
}
