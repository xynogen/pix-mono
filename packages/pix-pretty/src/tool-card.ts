/**
 * tool-card — the call row and result card every self-rendered tool shares.
 *
 * One place owns the order: a bare or partial error first, then the auto-collapsed
 * row, then a structured error, then the tool's own body inside the result frame.
 * A tool supplies only what differs: which details are its own, the collapsed row
 * text, and the body.
 */

import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";
import { resolveBaseBackground } from "./ansi.ts";
import type {
	RenderContextLike,
	TextComponentCtor,
	TextComponentLike,
	ThemeLike,
	ToolResultLike,
} from "./types.ts";
import {
	frameToolResult,
	getTextContent,
	hideCollapsedToolCall,
	renderCollapsed,
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
