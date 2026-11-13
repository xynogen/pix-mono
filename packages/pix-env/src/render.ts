/** render.ts — the `read_env` result card. */

import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { Text, type ToolRenderResultOptions } from "@xynogen/pix-pretty/tui";
import type { RenderContextLike, ThemeLike, ToolResultLike } from "@xynogen/pix-pretty/types";
import {
	BODY_PAD,
	expandHint,
	frameToolResult,
	getTextContent,
	pluralize,
	renderDimPreview,
	renderRow,
} from "@xynogen/pix-pretty/utils";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";

export interface ReadEnvDetails {
	action?: string;
	name?: string;
	path?: string;
	revealed?: string[];
	outcome?: string;
	count?: number;
	types?: Record<string, "boolean" | "int" | "float" | "string">;
}

/** Body rows under the header: the typed name list (info), hidden names (read), or the text. */
function bodyRows(
	result: ToolResultLike,
	details: ReadEnvDetails | undefined,
	names: string[],
	hiddenRead: boolean,
	expanded: boolean,
	theme: ThemeLike,
	renderCtx: RenderContextLike,
): string[] {
	const rows: string[] = [];
	const entries = Object.entries(details?.types ?? {});
	if (entries.length) {
		const shown = expanded ? entries : entries.slice(0, 12);
		for (const [name, type] of shown)
			rows.push(
				`${BODY_PAD}${icon(`data.${type}`)} ${theme.fg("accent", name)}${theme.fg("muted", ` · ${type}`)}`,
			);
		if (entries.length > shown.length)
			rows.push(
				`${BODY_PAD}${theme.fg("muted", `… ${entries.length - shown.length} more variables `)}${expandHint(theme, renderCtx)}`,
			);
	} else if (hiddenRead && names.length) {
		for (const name of names)
			rows.push(`${BODY_PAD}${theme.fg("accent", name)}${theme.fg("muted", " · value hidden")}`);
	} else {
		const text = getTextContent(result) || "No env variables loaded.";
		rows.push(
			renderDimPreview(text, theme, {
				maxLines: expanded || renderCtx.isError ? Number.MAX_SAFE_INTEGER : 8,
				ctx: renderCtx,
			}),
		);
	}
	if (details?.path)
		rows.push(`${BODY_PAD}${theme.fg("muted", "File · ")}${theme.fg("dim", details.path)}`);
	return rows;
}

export function renderReadEnvResult(
	result: ToolResultLike,
	options: ToolRenderResultOptions,
	theme: ThemeLike,
	renderCtx: RenderContextLike,
) {
	const details = result.details as ReadEnvDetails | undefined;
	const hiddenRead = details?.action === "read" && !renderCtx.isError;
	const names = hiddenRead ? (details?.revealed ?? []) : details?.name ? [details.name] : [];
	const target =
		names.join(", ") || (details?.count !== undefined ? pluralize(details.count, "variable") : "");
	const status = renderCtx.isError
		? "error"
		: details?.outcome && details.outcome !== "approved"
			? "warning"
			: "success";
	const collapsed =
		!options.isPartial &&
		tickCollapse(
			"read_env",
			renderCtx.state as CollapseState,
			renderCtx.invalidate,
			options.expanded,
		);
	const component = {
		render(width: number): string[] {
			const header = renderRow(
				theme,
				details?.action ? `read_env · ${details.action}` : "read_env",
				target,
				details?.outcome ?? (hiddenRead || details?.name ? "values hidden" : ""),
				status,
				width,
			);
			if (collapsed) return [header];
			const body = bodyRows(result, details, names, hiddenRead, options.expanded, theme, renderCtx);
			return new Text([header, ...body].join("\n"), 0, 0).render(width);
		},
		invalidate() {},
	};
	return options.isPartial || collapsed
		? component
		: frameToolResult(component, theme, renderCtx.isError);
}
