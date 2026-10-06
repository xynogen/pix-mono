import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import type {
	AgentToolUpdateCallback,
	ExtensionContext,
	ReadToolInput,
} from "@earendil-works/pi-coding-agent";
import {
	detectSupportedImageMimeTypeFromFile,
	type ReadToolOptions,
	truncateHead,
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
	BODY_PAD,
	dotJoin,
	fillToolBackground,
	formatToolCallTitle,
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
import { anchor, decodeLines } from "@xynogen/pix-runtime/hashline";

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
	modelContent?: string;
	notice?: string;
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
		body: item.modelContent ?? item.content,
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
			"Read text as LINE#HASH|source anchors for edit, or attach images. Text defaults to 400 lines, capped at 2,000 lines/50KB including anchors. Use offset/limit to continue. Pass paths for a batch.",
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
				let captured: Buffer | undefined;
				let image = false;
				const injected = (
					createReadTool as ToolFactory<ReadToolInput> &
						((cwd: string, options: ReadToolOptions) => ReturnType<ToolFactory<ReadToolInput>>)
				)(cwd, {
					operations: {
						access: (fp) => access(fp, constants.R_OK),
						readFile: async (fp) => {
							captured = await readFile(fp);
							return captured;
						},
						detectImageMimeType: async (fp) => {
							const mime = await detectSupportedImageMimeTypeFromFile(fp);
							image = Boolean(mime);
							return mime;
						},
					},
				});
				const result = (await injected.execute(
					callId,
					{ ...effectiveParams, offset: 1, limit: 1 },
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
				if (image) return result;
				if (!captured) throw new Error("Read operation did not capture source bytes");
				if (
					!Number.isSafeInteger(offset) ||
					offset < 1 ||
					!Number.isSafeInteger(effectiveParams.limit) ||
					effectiveParams.limit! < 1
				)
					throw new Error("offset and limit must be positive integers");
				const source = decodeLines(captured);
				if (source.lines.length && offset > source.lines.length)
					throw new Error(
						`Offset ${offset} is beyond end of file (${source.lines.length} lines total)`,
					);
				const selected = source.lines.slice(offset - 1, offset - 1 + effectiveParams.limit!);
				const annotated = selected
					.map((line, i) => `${anchor(offset + i, line.text)}|${line.text}`)
					.join("\n");
				let capped = truncateHead(annotated);
				if (offset - 1 + capped.outputLines < source.lines.length) {
					const reserve = Buffer.byteLength(
						`[Read continues at offset=${offset + selected.length}. The next line exceeds the byte limit.]\n\n`,
					);
					capped = truncateHead(annotated, { maxBytes: BATCH_MAX_BYTES - reserve });
				}
				const count = capped.outputLines;
				const notice =
					offset - 1 + count < source.lines.length
						? `[Read continues at offset=${offset + count}. ${capped.firstLineExceedsLimit ? "The next line exceeds the byte limit." : ""}]`
						: "";
				result.content = [
					{ type: "text", text: [capped.content, notice].filter(Boolean).join("\n\n") },
				];
				setResultDetails(result, {
					_type: "readFile",
					filePath: path,
					content: selected
						.slice(0, count)
						.map((line) => line.text)
						.join("\n"),
					offset,
					lineCount: count,
					modelContent: capped.content,
					notice,
				});
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
			let budget = BATCH_MAX_BYTES;
			let index = "";
			let text = "";
			const originals = items.map(sectionFromItem);
			do {
				const capped = capSections(
					originals,
					budget,
					Math.min(params.limit ?? DEFAULT_READ_LIMIT, 2000),
					omitted,
				);
				index = capped.index;
				// capSections can cut its first line. Never publish a partial source anchor.
				const blocks = capped.sections.map((section, i) => {
					const originalLines = originals[i]!.body.split("\n");
					const complete = section.body
						.split("\n")
						.filter((line, n) => line === originalLines[n])
						.join("\n");
					const item = items[i]!;
					const notice = section.truncated
						? `[Read continues. Use offset=${(item._type === "readFile" ? item.offset : 1) + (complete ? complete.split("\n").length : 0)}.]`
						: item._type === "readFile"
							? item.notice
							: "";
					return `===== ${section.id} =====\n${section.error ?? [complete, notice].filter(Boolean).join("\n\n")}`;
				});
				text = [index, ...blocks].join("\n\n");
				const excess = Buffer.byteLength(text) - BATCH_MAX_BYTES;
				if (excess <= 0) break;
				if (budget === 0)
					throw new Error("Batch metadata exceeds the byte limit. Read fewer paths.");
				budget = Math.max(0, budget - excess);
			} while (Buffer.byteLength(text) > BATCH_MAX_BYTES);
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
					`${formatToolCallTitle(theme, "read", renderCtx)} ${theme.fg("dim", sp(fp))}${offset}${limit}`,
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
						`${BODY_PAD}${fileIcon(d.filePath as string, theme)}${theme.fg("dim", dotJoin([String(d.mimeType ?? "image"), humanSize(byteSize)]))}`,
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
					const loading = `${BODY_PAD}${theme.fg("muted", "reading…")}`;
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
								? [`${BODY_PAD}${theme.fg("muted", "reading…")}`]
								: ruleFrame([`${BODY_PAD}${theme.fg("muted", "reading…")}`], [], undefined, paint)
							).join("\n"),
						),
				);
				return text;
			}

			const fallback = result.content?.[0];
			const fallbackText = fallback && isTextContent(fallback) ? fallback.text : "read";
			text.setText(
				fillToolBackground(`${BODY_PAD}${theme.fg("dim", String(fallbackText).slice(0, 120))}`),
			);
			return isPartial ? text : completed();
		},
	});
}
