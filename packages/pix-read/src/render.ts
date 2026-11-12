/** read tool card: result body for a file, an image, or a batch. */

import { formatCallTargets } from "@xynogen/pix-pretty/batch";
import { MAX_PREVIEW_LINES } from "@xynogen/pix-pretty/config";
import type { ToolContext } from "@xynogen/pix-pretty/context";
import { fileIcon } from "@xynogen/pix-pretty/icons";
import { renderFileContent } from "@xynogen/pix-pretty/renderers";
import type { RenderContextLike, TextComponentLike, ThemeLike } from "@xynogen/pix-pretty/types";
import {
	BODY_PAD,
	dotJoin,
	fadeRulePaint,
	fillToolBackground,
	getErrorMessage,
	humanSize,
	renderDimPreview,
	renderToolError,
	ruleFrame,
} from "@xynogen/pix-pretty/utils";
import { createHash } from "@xynogen/pix-runtime/crypto";

export type ReadFileDetails = {
	_type: "readFile";
	filePath: string;
	content: string;
	offset: number;
	lineCount: number;
	modelContent?: string;
	notice?: string;
};
export type ReadImageDetails = {
	_type: "readImage";
	filePath: string;
	data: string;
	mimeType: string;
};
export type ReadErrorDetails = { _type: "readError"; filePath: string; message: string };
export type ReadItem = ReadFileDetails | ReadImageDetails | ReadErrorDetails;
export type ReadBatchDetails = { _type: "readBatch"; items: ReadItem[]; index: string };
type ReadDetails = ReadItem | ReadBatchDetails;

/** Theme roles the highlighted body depends on; a change re-renders the cached body. */
const SYNTAX_ROLES = [
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxVariable",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxOperator",
	"syntaxPunctuation",
	"syntaxComment",
] as const;

const imageMeta = (d: ReadImageDetails) =>
	dotJoin([d.mimeType ?? "image", humanSize(Math.ceil((d.data.length * 3) / 4))]);

/** Target and summary of the row shown once the card auto-collapses. */
export function collapsedParts(
	d: ReadDetails | undefined,
	sp: ToolContext["sp"],
): { target: string; summary: string } {
	if (d?._type === "readBatch")
		return {
			target: formatCallTargets(d.items.map((item) => sp(item.filePath))),
			summary: `${d.items.length} files`,
		};
	if (d?._type === "readFile") return { target: sp(d.filePath), summary: `${d.lineCount} lines` };
	if (d?._type === "readImage") return { target: sp(d.filePath), summary: imageMeta(d) };
	return { target: "", summary: "done" };
}

/** Batch body: index line, then one highlighted section per file (async, cached in state). */
export function renderBatch(
	batch: ReadBatchDetails,
	text: TextComponentLike,
	theme: ThemeLike,
	renderCtx: RenderContextLike,
	isPartial: boolean,
): void {
	const key = JSON.stringify([
		batch,
		renderCtx.expanded,
		isPartial,
		process.stdout.columns,
		...[...SYNTAX_ROLES, "dim", "muted"].map((role) => theme.fg(role, "sample")),
	]);
	if (renderCtx.state._rbk !== key) {
		renderCtx.state._rbk = key;
		renderCtx.state._rbt = undefined;
		Promise.all(
			batch.items.map(async (item) => {
				const header = `${BODY_PAD}${fileIcon(item.filePath, theme)}${theme.fg("dim", item.filePath)}`;
				const body =
					item._type === "readFile"
						? await renderFileContent(
								item.content,
								item.filePath,
								item.offset,
								renderCtx.expanded ? item.lineCount : MAX_PREVIEW_LINES,
								theme,
								{ wrapLongLines: renderCtx.expanded, ctx: renderCtx },
							)
						: renderDimPreview(item._type === "readError" ? item.message : item.mimeType, theme, {
								ctx: renderCtx,
							});
				return `${header}\n${body}`;
			}),
		)
			.then((sections) => {
				if (renderCtx.state._rbk !== key) return;
				renderCtx.state._rbt = fillToolBackground(
					[`${BODY_PAD}${theme.fg("dim", batch.index)}`, ...sections].join("\n\n"),
				);
				renderCtx.invalidate();
			})
			.catch((error: unknown) => {
				if (renderCtx.state._rbk !== key) return;
				renderCtx.state._rbt = renderToolError(getErrorMessage(error), theme);
				renderCtx.invalidate();
			});
	}
	const full = batch.items
		.map(
			(item) =>
				`===== ${item.filePath} =====\n${item._type === "readError" ? item.message : item._type === "readImage" ? item.mimeType : item.content}`,
		)
		.join("\n\n");
	text.setText(
		renderCtx.state._rbt ??
			renderDimPreview(full || batch.index, theme, {
				header: batch.index,
				ctx: renderCtx,
				...(renderCtx.expanded ? { maxLines: Number.MAX_SAFE_INTEGER } : {}),
			}),
	);
}

export function renderImage(d: ReadImageDetails, text: TextComponentLike, theme: ThemeLike): void {
	text.setText(
		fillToolBackground(`${BODY_PAD}${fileIcon(d.filePath, theme)}${theme.fg("dim", imageMeta(d))}`),
	);
}

/** File body: highlighted lines in a status-ruled frame (async, cached in state). */
export function renderFile(
	d: ReadFileDetails,
	text: TextComponentLike,
	theme: ThemeLike,
	renderCtx: RenderContextLike,
	isPartial: boolean,
): void {
	const themeKey = ["muted", "success", ...SYNTAX_ROLES]
		.map((role) => theme.fg(role, "sample"))
		.join("|");
	const contentKey = createHash("sha256").update(d.content).digest("hex");
	const key = JSON.stringify([
		d.filePath,
		d.offset,
		d.lineCount,
		process.stdout.columns ?? 80,
		renderCtx.expanded,
		isPartial,
		themeKey,
		contentKey,
	]);
	// One framed shape; rules follow status color. The line count lives in the
	// collapsed row — no floating "N lines" header above the frame.
	const paint = fadeRulePaint(theme, "success");
	const frame = (rows: string[]) =>
		fillToolBackground((isPartial ? rows : ruleFrame(rows, [], undefined, paint)).join("\n"));
	const loading = frame([`${BODY_PAD}${theme.fg("muted", "reading…")}`]);
	if (renderCtx.state._rk !== key) {
		renderCtx.state._rk = key;
		renderCtx.state._rt = loading;
		renderFileContent(
			d.content,
			d.filePath,
			d.offset,
			renderCtx.expanded ? d.lineCount : MAX_PREVIEW_LINES,
			theme,
			// Expanded view wraps long lines so no source tail is hidden behind ›.
			{ wrapLongLines: renderCtx.expanded, ctx: renderCtx },
		)
			.then((rendered: string) => {
				if (renderCtx.state._rk !== key) return;
				renderCtx.state._rt = frame(rendered.split("\n"));
				renderCtx.invalidate();
			})
			.catch(() => {});
	}
	text.setText(renderCtx.state._rt ?? loading);
}
