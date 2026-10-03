import type {
	AgentToolUpdateCallback,
	ExtensionContext,
	ReadToolInput,
} from "@earendil-works/pi-coding-agent";
import { resolveBaseBackground } from "@xynogen/pix-pretty/ansi";
import {
	BATCH_MAX_BYTES,
	type BatchSection,
	capSections,
	formatCallTargets,
	resolveBatchStrings,
	sliceBatchTargets,
	withOptionalStringArray,
} from "@xynogen/pix-pretty/batch";
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
	frameToolResult,
	getErrorMessage,
	getTextContent,
	hideCollapsedToolCall,
	humanSize,
	isImageContent,
	isTextContent,
	normalizeLineEndings,
	renderCollapsedToolRow,
	renderDimPreview,
	renderToolError,
	ruleFrame,
	setResultDetails,
	unframeToolResult,
} from "@xynogen/pix-pretty/utils";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";

export const DEFAULT_READ_LIMIT = 400;

const LINE_NOUNS = ["line", "lines"] as const;

/** ReadParams plus the optional batch `paths` array (added to the schema at runtime). */
type ReadBatchParams = ReadParams & { paths?: string[] };

type ReadFileDetails = {
	_type: "readFile";
	filePath: string;
	content: string;
	offset: number;
	lineCount: number;
};
type ReadImageDetails = {
	_type: "readImage";
	filePath: string;
	data: string;
	mimeType: string;
};
type ReadErrorDetails = { _type: "readError"; filePath: string; message: string };
type ReadItem = ReadFileDetails | ReadImageDetails | ReadErrorDetails;
type ReadBatchDetails = { _type: "readBatch"; items: ReadItem[]; index: string };

export function applyReadDefaults(params: ReadParams): ReadParams {
	return params.limit === undefined ? { ...params, limit: DEFAULT_READ_LIMIT } : params;
}

function itemFromResult(fp: string, offset: number, result: ToolResultLike): ReadItem {
	const d = result.details as ReadItem | undefined;
	if (d?._type === "readImage" || d?._type === "readFile") return d;
	const image = result.content?.find(isImageContent);
	if (image) {
		return {
			_type: "readImage",
			filePath: fp,
			data: image.data,
			mimeType: image.mimeType ?? "image/png",
		};
	}
	const text = normalizeLineEndings(getTextContent(result));
	return {
		_type: "readFile",
		filePath: fp,
		content: text,
		offset,
		lineCount: text ? text.split("\n").length : 0,
	};
}

function sectionFromItem(item: ReadItem): BatchSection {
	if (item._type === "readError") {
		return { id: item.filePath, body: "", units: 0, nouns: LINE_NOUNS, error: item.message };
	}
	if (item._type === "readImage") {
		return { id: item.filePath, body: "", units: 1, nouns: ["image", "images"] };
	}
	return {
		id: item.filePath,
		body: item.content,
		units: item.lineCount,
		nouns: LINE_NOUNS,
		hint: "use offset",
	};
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
			"Read text files and images. Text reads default to 400 lines and remain capped by Pi's 2,000-line/50KB hard limit. Use offset/limit to continue large files. Pass `paths` to read several known files in one call.",
		parameters: withOptionalStringArray(
			origRead.parameters,
			"paths",
			"Known files to read in one call (each capped, one combined result). Use instead of `path` for multiple known files.",
			["path"],
		),
		// Full-width framing baked at termW(); default Box shell pads x by 1
		// and re-wraps at width-2, splitting every line into a padding row.
		renderShell: "self",

		async execute(
			tid: string,
			params: ReadBatchParams,
			sig: AbortSignal | undefined,
			upd: AgentToolUpdateCallback<unknown> | undefined,
			toolCtx: ExtensionContext,
		) {
			const { targets, omitted } = sliceBatchTargets(
				resolveBatchStrings(params.path, params.paths),
			);
			const offset = params.offset ?? 1;

			const runOne = async (path: string, callId: string): Promise<ToolResultLike> => {
				const { paths: _paths, ...rest } = params;
				const effectiveParams = applyReadDefaults({ ...rest, path });
				const result = (await origRead.execute(
					callId,
					effectiveParams,
					sig,
					upd,
					toolCtx,
				)) as ToolResultLike;
				const imageBlock = result.content?.find(isImageContent);
				if (imageBlock) {
					setResultDetails(result, {
						_type: "readImage",
						filePath: path,
						data: imageBlock.data,
						mimeType: imageBlock.mimeType ?? "image/png",
					});
					return result;
				}
				const textContent = getTextContent(result);
				if (textContent && path) {
					const normalizedContent = normalizeLineEndings(textContent);
					setResultDetails(result, {
						_type: "readFile",
						filePath: path,
						content: normalizedContent,
						offset,
						lineCount: normalizedContent.split("\n").length,
					});
				}
				return result;
			};

			// Single target → preserve the original single-file result/detail shape.
			if (targets.length <= 1 && omitted === 0) {
				const fp = targets[0] ?? params.path ?? "";
				try {
					return await runOne(fp, tid);
				} catch (error) {
					const text = getErrorMessage(error);
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
			}

			// Batch: read all targets in parallel, cap the combined output.
			const settled = await Promise.all(
				targets.map(async (path, i) => {
					try {
						return { path, result: await runOne(path, `${tid}:${i}`) };
					} catch (error) {
						if (sig?.aborted) throw error;
						return { path, error: getErrorMessage(error) };
					}
				}),
			);
			const items: ReadItem[] = settled.map((entry) =>
				"error" in entry && entry.error
					? { _type: "readError", filePath: entry.path, message: entry.error }
					: itemFromResult(entry.path, offset, entry.result as ToolResultLike),
			);
			const { index, text } = capSections(
				items.map(sectionFromItem),
				BATCH_MAX_BYTES,
				params.limit ?? DEFAULT_READ_LIMIT,
				omitted,
			);
			const images = items.filter((i): i is ReadImageDetails => i._type === "readImage");
			const details: ReadBatchDetails = { _type: "readBatch", items, index };
			return {
				content: [
					{ type: "text" as const, text },
					...images.map((img) => ({
						type: "image" as const,
						data: img.data,
						mimeType: img.mimeType,
					})),
				],
				details,
			};
		},

		renderCall(args: ReadBatchParams, theme: ThemeLike, renderCtx: RenderContextLike) {
			resolveBaseBackground(theme);
			const batchTargets = resolveBatchStrings(args.path, args.paths);
			const fp =
				batchTargets.length > 1 ? formatCallTargets(batchTargets.map(sp)) : (args.path ?? "");
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
					`${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("dim", sp(fp))}${offset}${limit}`,
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
			const text = unframeToolResult(renderCtx.lastComponent ?? new TextComponent("", 0, 0));
			const d = result.details as Record<string, unknown> | undefined;
			const isPartial = (_opt as { isPartial?: boolean } | undefined)?.isPartial === true;
			const completed = () => frameToolResult(text, theme, renderCtx.isError);
			const structuredError =
				renderCtx.isError && (d?._type === "readFile" || d?._type === "readImage");

			if (renderCtx.isError && (!structuredError || isPartial)) {
				text.setText(renderToolError(getTextContent(result) || "Error", theme));
				return isPartial ? text : completed();
			}

			// Auto-collapse: show summary line after delay
			const cs = renderCtx.state as CollapseState;
			if (!isPartial && tickCollapse("read", cs, renderCtx.invalidate, renderCtx.expanded)) {
				if (renderCtx.isError) {
					text.setText(
						renderCollapsedToolRow(theme, "read", sp(String(d?.filePath ?? "")), "failed", "error"),
					);
				} else if (d?._type === "readBatch") {
					// SAFETY: _type discriminant is "readBatch", set only where we build ReadBatchDetails.
					const batch = d as unknown as ReadBatchDetails;
					text.setText(
						renderCollapsedToolRow(
							theme,
							"read",
							formatCallTargets(batch.items.map((item) => sp(item.filePath))),
							`${batch.items.length} files`,
						),
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
				return completed();
			}

			if (d?._type === "readBatch") {
				// SAFETY: _type discriminant is "readBatch", set only where we build ReadBatchDetails.
				const batch = d as unknown as ReadBatchDetails;
				const full = batch.items
					.map((item) =>
						item._type === "readError"
							? `===== ${item.filePath} =====\n${item.message}`
							: item._type === "readImage"
								? `===== ${item.filePath} =====\n${item.mimeType}`
								: `===== ${item.filePath} =====\n${item.content}`,
					)
					.join("\n\n");
				text.setText(
					renderDimPreview(full || batch.index, theme, {
						header: batch.index,
						...(renderCtx.expanded ? { maxLines: Number.MAX_SAFE_INTEGER } : {}),
					}),
				);
				return isPartial ? text : completed();
			}

			if (d?._type === "readImage") {
				const byteSize = Math.ceil(((d.data as string).length * 3) / 4);
				text.setText(
					fillToolBackground(
						`${fileIcon(d.filePath as string, theme)}${theme.fg("dim", dotJoin([String(d.mimeType ?? "image"), humanSize(byteSize)]))}`,
					),
				);
				return isPartial ? text : completed();
			}

			if (d?._type === "readFile" && d.content) {
				const key = `read:${d.filePath}:${d.offset}:${d.lineCount}:${process.stdout.columns ?? 80}:${renderCtx.expanded ? "full" : "preview"}:${isPartial ? "partial" : "complete"}`;
				// One framed shape; rules follow status color. The line count lives in the
				// collapsed row — no floating "N lines" header above the frame.
				const paint = (s: string) => theme.fg("success", s);
				if (renderCtx.state._rk !== key) {
					renderCtx.state._rk = key;
					const loading = theme.fg("muted", "reading…");
					renderCtx.state._rt = fillToolBackground(
						(isPartial ? [loading] : ruleFrame([loading], [], undefined, paint)).join("\n"),
					);

					const maxShow = renderCtx.expanded ? (d.lineCount as number) : MAX_PREVIEW_LINES;
					renderFileContent(
						d.content as string,
						d.filePath as string,
						d.offset as number,
						maxShow,
						theme,
						// Expanded view wraps long lines so no source tail is hidden behind ›.
						{ wrapLongLines: renderCtx.expanded },
					)
						.then((rendered: string) => {
							if (renderCtx.state._rk !== key) return;
							const lines = rendered.split("\n");
							renderCtx.state._rt = fillToolBackground(
								(isPartial ? lines : ruleFrame(lines, [], undefined, paint)).join("\n"),
							);
							renderCtx.invalidate();
						})
						.catch(() => {});
				}
				text.setText(
					renderCtx.state._rt ??
						fillToolBackground(
							(isPartial
								? [theme.fg("muted", "reading…")]
								: ruleFrame([theme.fg("muted", "reading…")], [], undefined, paint)
							).join("\n"),
						),
				);
				return text;
			}

			const fallback = result.content?.[0];
			const fallbackText = fallback && isTextContent(fallback) ? fallback.text : "read";
			text.setText(fillToolBackground(theme.fg("dim", String(fallbackText).slice(0, 120))));
			return isPartial ? text : completed();
		},
	});
}
