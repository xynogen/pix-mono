/**
 * tool-card — the call row and result card every self-rendered tool shares.
 *
 * One place owns the order: a bare or partial error first, then the auto-collapsed
 * row, then a structured error, then the tool's own body inside the result frame.
 * A tool supplies only what differs: which details are its own, the collapsed row
 * text, and the body.
 */

import { Box, Markdown } from "@earendil-works/pi-tui";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";
import { resolveBaseBackground } from "./ansi.ts";
import { fadeRowsOf } from "./text.ts";
import { getMarkdownTheme } from "./tui.ts";
import type {
	RenderContextLike,
	TextComponentCtor,
	TextComponentLike,
	ThemeLike,
	ToolResultLike,
} from "./types.ts";
import {
	BODY_PAD,
	bodyLine,
	type CollapsedToolStatus,
	frameToolResult,
	getTextContent,
	hideCollapsedToolCall,
	moreLines,
	renderCollapsed,
	renderRow,
	renderToolError,
	reuseText,
} from "./utils.ts";

type RenderState = Record<string, string | undefined>;

export interface ToolCardBody<D, S extends RenderState> {
	d: D | undefined;
	result: ToolResultLike<D>;
	text: TextComponentLike;
	theme: ThemeLike;
	ctx: RenderContextLike<S>;
	isPartial: boolean;
}

export interface ToolCardSpec<D, S extends RenderState> {
	/** Tool name: the collapse key and the collapsed row title. */
	name: string;
	/** True for details this tool produced. An error that carries them still renders as a card. */
	owns(d: D | undefined): boolean;
	/** Collapsed row target and success summary. A failed call shows "failed" instead. */
	collapsed(d: D | undefined): { target: string; summary: string };
	/** Set the expanded body. Return "framed" when the body drew its own frame. */
	body(input: ToolCardBody<D, S>): "framed" | undefined;
}

/** `renderResult` for a self-rendered tool card. */
export function toolCardRenderer<D = Record<string, unknown>, S extends RenderState = RenderState>(
	TextComponent: TextComponentCtor,
	spec: ToolCardSpec<D, S>,
) {
	return (
		result: ToolResultLike<D>,
		options: { isPartial?: boolean } | undefined,
		theme: ThemeLike,
		ctx: RenderContextLike<S>,
	) => {
		resolveBaseBackground(theme);
		const text = reuseText(ctx.lastComponent, TextComponent);
		const d = result.details ?? undefined;
		const isPartial = options?.isPartial === true;
		const completed = () => frameToolResult(text, theme, ctx.isError);
		const showError = () => text.setText(renderToolError(getTextContent(result) || "Error", theme));

		if (ctx.isError && (!spec.owns(d) || isPartial)) {
			showError();
			return isPartial ? text : completed();
		}
		if (
			!isPartial &&
			tickCollapse(spec.name, ctx.state as CollapseState, ctx.invalidate, ctx.expanded)
		) {
			const { target, summary } = spec.collapsed(d);
			const failed = ctx.isError;
			text.setText(
				renderCollapsed(
					theme,
					spec.name,
					target,
					failed ? "failed" : summary,
					failed ? "error" : "success",
				),
			);
			return text;
		}
		if (ctx.isError) {
			showError();
			return completed();
		}
		const framed = spec.body({ d, result, text, theme, ctx, isPartial });
		return framed === "framed" || isPartial ? text : completed();
	};
}

/** `renderCall` for a self-rendered tool: hidden once its result collapsed, else `line`. */
export function toolCallRenderer<A, S extends RenderState = RenderState>(
	TextComponent: TextComponentCtor,
	line: (args: A, theme: ThemeLike, ctx: RenderContextLike<S>) => string,
) {
	return (args: A, theme: ThemeLike, ctx: RenderContextLike<S>) => {
		resolveBaseBackground(theme);
		const text = reuseText(ctx.lastComponent, TextComponent);
		if (hideCollapsedToolCall(ctx.state as CollapseState, ctx.expanded, (v) => text.setText(v)))
			return text;
		text.setText(line(args, theme, ctx));
		return text;
	};
}

/** A tool whose result body is fetched/searched text: a preview while collapsed, all when expanded. */
export interface BodyCardSpec<D> {
	/** Tool name: the collapse key and the default collapsed-row title. */
	tool: string;
	/** Collapsed-row title when it differs from `tool`. */
	title?: string;
	/** Collapsed-row target and summary; both default to empty. */
	target?(d: D): string;
	meta?(d: D): string;
	status?(d: D): CollapsedToolStatus;
	/** Preview budget in rows while collapsed; expanding shows everything. Default 16. */
	maxPreviewLines?: number;
	/** Render a successful body as Markdown (fades its tail) instead of dim text. */
	markdown?: boolean;
}

/**
 * `renderResult` for a text-body tool: error and empty states first, then the auto-collapsed
 * row, then the body — dim text, or Markdown for `spec.markdown` — inside the result frame.
 */
export function bodyCardRenderer<D = Record<string, unknown>, S extends RenderState = RenderState>(
	TextComponent: TextComponentCtor,
	spec: BodyCardSpec<D>,
) {
	const maxPreview = spec.maxPreviewLines ?? 16;
	const dimBody = (
		body: string,
		theme: ThemeLike,
		ctx: RenderContextLike<S>,
		expanded: boolean,
	) => {
		const lines = body.split("\n");
		const shown = expanded ? lines.length : maxPreview;
		const out = fadeRowsOf(
			lines.slice(0, shown + 1).map((line) => bodyLine(line, theme, (l) => theme.fg("dim", l))),
			theme,
			shown,
		);
		const hidden = lines.length - shown;
		if (hidden > 0) out.push(moreLines(hidden, theme, ctx));
		return out.join("\n");
	};
	const markdownBody = (
		body: string,
		theme: ThemeLike,
		ctx: RenderContextLike<S>,
		expanded: boolean,
	) => {
		const view = new Box(0, 0);
		const page = new Markdown(body, 3, 0, getMarkdownTheme(), {
			color: (value) => theme.fg("dim", value),
		});
		if (expanded) view.addChild(page);
		// Fade the last preview rows of the rendered page instead of a hard cut.
		else
			view.addChild({
				invalidate: () => page.invalidate(),
				render: (width: number) => {
					const rows = page.render(width);
					const hidden = rows.length - maxPreview;
					const shownRows = fadeRowsOf(rows, theme, maxPreview);
					return hidden > 0 ? [...shownRows, moreLines(hidden, theme, ctx)] : shownRows;
				},
			});
		return view;
	};

	return (
		result: ToolResultLike,
		options: { isPartial?: boolean; expanded?: boolean } | undefined,
		theme: ThemeLike,
		ctx: RenderContextLike<S>,
	) => {
		resolveBaseBackground(theme);
		const text = reuseText(ctx.lastComponent, TextComponent);
		const isPartial = options?.isPartial === true;
		const expanded = options?.expanded ?? ctx.expanded;
		const body = getTextContent(result);

		if (ctx.isError || !body.trim()) {
			text.setText(
				`${BODY_PAD}${ctx.isError ? theme.fg("error", body || "Error") : theme.fg("muted", "(empty)")}`,
			);
			return isPartial ? text : frameToolResult(text, theme, ctx.isError);
		}

		// SAFETY: the renderer receives the tool's own details; the spec types them as D.
		const d = (result.details ?? undefined) as D | undefined;
		if (
			!isPartial &&
			d &&
			tickCollapse(spec.tool, ctx.state as CollapseState, ctx.invalidate, expanded)
		) {
			text.setText(
				renderRow(
					theme,
					spec.title ?? spec.tool,
					spec.target?.(d) ?? "",
					spec.meta?.(d) ?? "",
					spec.status?.(d) ?? "success",
				),
			);
			return text;
		}

		const failed = Boolean(d && spec.status?.(d) === "error");
		if (spec.markdown && !failed && !isPartial)
			return frameToolResult(markdownBody(body, theme, ctx, expanded), theme, false);
		text.setText(dimBody(body, theme, ctx, expanded));
		return isPartial ? text : frameToolResult(text, theme, failed);
	};
}
