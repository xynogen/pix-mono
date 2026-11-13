/** render.ts — the shared `ast` card: call title per action, one result renderer for all actions. */

import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { Text, type Theme, type ToolRenderResultOptions } from "@xynogen/pix-pretty/tui";
import type { RenderContextLike, ThemeLike, ToolResultLike } from "@xynogen/pix-pretty/types";
import {
	frameToolResult,
	getTextContent,
	hideCollapsedToolCall,
	renderRow,
	renderTitle,
} from "@xynogen/pix-pretty/utils";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";

/** `renderCall` for one action: `rest` builds the dim argument text after the title. */
export function astCall<A>(action: string, rest: (args: A, t: Theme) => string) {
	return (args: unknown, theme: ThemeLike, context: RenderContextLike) => {
		if (hideCollapsedToolCall(context.state as CollapseState, context.expanded, () => {}))
			return new Text("", 0, 0);
		const t = theme as Theme;
		const title = renderTitle(t, "ast", context, action);
		return new Text(`${title} ${rest(args as A, t)}`.trimEnd(), 0, 0);
	};
}

/** `renderResult` for one action: collapsed row, else status glyph and the text output. */
export function astResult(action: string) {
	return (
		result: ToolResultLike,
		options: ToolRenderResultOptions,
		theme: ThemeLike,
		context: RenderContextLike,
	) => {
		const text = getTextContent(result);
		const details = result.details as { outcome?: string } | undefined;
		const isError = context.isError || details?.outcome === "error";
		const role = isError ? "error" : "success";
		if (
			!options.isPartial &&
			tickCollapse("ast", context.state as CollapseState, context.invalidate, options.expanded)
		)
			return new Text(
				renderRow(theme, `ast · ${action}`, "", `${text.split("\n").length} lines`, role),
				0,
				0,
			);
		const glyph = isError ? icon("status.error") : icon("status.ok");
		const body = new Text(`${theme.fg(role, glyph)} ${text}`, 0, 0);
		if (options.isPartial) return body;
		return frameToolResult(body, theme, isError);
	};
}
