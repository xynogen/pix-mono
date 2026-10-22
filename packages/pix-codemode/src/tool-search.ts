import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { resolveBaseBackground } from "@xynogen/pix-pretty/ansi";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import type { ThemeLike } from "@xynogen/pix-pretty/types";
import {
	dotJoin,
	fillToolBackground,
	formatToolCallTitle,
	frameToolResult,
	hideCollapsedToolCall,
	padIcon,
	pluralize,
	renderCollapsedToolRow,
} from "@xynogen/pix-pretty/utils";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";

type Args = { query?: string; limit?: number };
type Context = {
	args?: Args;
	state: CollapseState;
	expanded: boolean;
	isError?: boolean;
	isPartial?: boolean;
	executionStarted?: boolean;
	invalidate: () => void;
};

// Body aligns under the tool name: status glyph (2 cols) + space. Rows share the heading column.
const BODY = "   ";

/** Wrapped text, every row indented to the body column. */
function bodyText(text: string) {
	return {
		render: (width: number) =>
			wrapTextWithAnsi(text, Math.max(10, width - BODY.length)).map((line) => BODY + line),
		invalidate() {},
	};
}

/**
 * Indented two-column list: names padded to one column so descriptions line up.
 * Collapsed clips each description to one row; expanded wraps it under its column.
 */
function toolTable(
	heading: string,
	rows: { name: string; desc: string }[],
	theme: ThemeLike,
	expanded: boolean,
) {
	const glyph = theme.fg("muted", padIcon(icon("tools")));
	return {
		render(width: number) {
			// ponytail: the name column caps at half the width. Longer names push their description to the next row.
			const col = Math.min(
				Math.max(...rows.map((row) => visibleWidth(row.name))),
				Math.floor(width / 2),
			);
			const lead = BODY.length + visibleWidth(padIcon(icon("tools"))) + 1;
			const gutter = " ".repeat(lead + col + 2);
			const descWidth = Math.max(10, width - gutter.length);
			const out = [BODY + truncateToWidth(heading, width - BODY.length, "…")];
			for (const { name, desc } of rows) {
				const nameWidth = visibleWidth(name);
				const head = `${BODY}${glyph} ${theme.fg("accent", name)}`;
				const body = expanded
					? wrapTextWithAnsi(theme.fg("dim", desc), descWidth)
					: [truncateToWidth(theme.fg("dim", desc), descWidth, "…")];
				if (nameWidth > col) {
					out.push(expanded ? head : truncateToWidth(head, width, "…"));
					if (desc) out.push(...body.map((line) => gutter + line));
					continue;
				}
				const [first = "", ...rest] = desc ? body : [""];
				out.push(`${head}${" ".repeat(col - nameWidth + 2)}${first}`.trimEnd());
				out.push(...rest.map((line) => gutter + line));
			}
			return out;
		},
		invalidate() {},
	};
}

export function renderToolSearchCall(args: Args, theme: ThemeLike, ctx: Context) {
	resolveBaseBackground(theme);
	const text = new Text("", 0, 0);
	if (hideCollapsedToolCall(ctx.state, ctx.expanded, (value) => text.setText(value))) return text;
	const limit = args.limit === undefined ? "" : ` ${theme.fg("muted", `(limit ${args.limit})`)}`;
	text.setText(
		fillToolBackground(
			dotJoin(
				[
					`${formatToolCallTitle(theme, "tool_search", ctx)}${limit}`,
					theme.fg("dim", args.query ?? ""),
				],
				(part) => theme.fg("muted", part),
			),
		),
	);
	return text;
}

export function renderToolSearchResult(
	result: AgentToolResult<{ loaded?: string[] }>,
	options: ToolRenderResultOptions,
	theme: ThemeLike,
	ctx: Context,
) {
	resolveBaseBackground(theme);
	const body = result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	if (options.isPartial) return new Text("", 0, 0);
	if (ctx.isError) return frameToolResult(bodyText(theme.fg("error", body)), theme, true);
	const loaded = result.details?.loaded ?? [];
	if (tickCollapse("tool_search", ctx.state, ctx.invalidate, options.expanded)) {
		return new Text(
			renderCollapsedToolRow(
				theme,
				"tool_search",
				ctx.args?.query ?? "",
				loaded.length ? `${pluralize(loaded.length, "tool")} loaded` : "no match",
			),
			0,
			0,
		);
	}
	if (!loaded.length) return frameToolResult(bodyText(theme.fg("muted", body)), theme, false);
	// ponytail: Pi's text format is `- name: first description line`. Unknown lines still show the name.
	const descriptions = new Map(
		body
			.split("\n")
			.map((line) => /^- ([^:]+): (.*)$/.exec(line))
			.filter((match) => match !== null)
			.map((match) => [match[1], match[2]] as const),
	);
	return frameToolResult(
		toolTable(
			theme.fg(
				"muted",
				`Loaded ${pluralize(loaded.length, "tool")}, available from the next call:`,
			),
			loaded.map((name) => ({ name, desc: descriptions.get(name) ?? "" })),
			theme,
			options.expanded,
		),
		theme,
		false,
	);
}
