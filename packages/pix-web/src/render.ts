/** Render web results as Markdown in the transcript without changing model content. */

import {
	type AgentToolResult,
	getMarkdownTheme,
	type Theme,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, Markdown, Text } from "@earendil-works/pi-tui";
import {
	BODY_PAD,
	bodyLine,
	type CollapsedToolStatus,
	formatCollapsedToolRow,
	frameToolResult,
	hideCollapsedToolCall,
	moreLines,
	unframeToolResult,
} from "@xynogen/pix-pretty/utils";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";

interface TextLike extends Component {
	setText(text: string): void;
}

// ToolRenderContext is not re-exported by pi-coding-agent; model the fields the
// renderers actually read. Structurally compatible with the SDK context.
interface RenderCtx {
	lastComponent: Component | undefined;
	isError: boolean;
	state: Record<string, unknown>;
	expanded: boolean;
	invalidate: () => void;
}

interface CompactRendererConfig<TDetails> {
	tool: string;
	target: (details: TDetails) => string;
	meta: (details: TDetails) => string;
	status?: (details: TDetails) => CollapsedToolStatus;
}

// ponytail: limit the preview by source lines; expand to see the full page.
const MAX_PREVIEW_LINES = 32;

function getText(lastComponent: Component | undefined): TextLike {
	const component = lastComponent && unframeToolResult(lastComponent as TextLike);
	return component instanceof Text ? component : new Text("", 0, 0);
}

function allText(result: AgentToolResult<unknown>): string {
	return (result.content ?? [])
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function dimBody(body: string, theme: Theme, expanded: boolean): string {
	const lines = body.split("\n");
	const maxShow = expanded ? lines.length : MAX_PREVIEW_LINES;
	const shown = lines.slice(0, maxShow);
	const out = shown.map((line) => bodyLine(line, theme, (l) => theme.fg("dim", l)));
	const remaining = lines.length - maxShow;
	if (remaining > 0) out.push(moreLines(remaining, theme));
	return out.join("\n");
}

/** Build a `renderCall` that shows `<title> <secondary arg>`. */
export function makeRenderCall<TArgs>(title: string, pickArg: (args: TArgs) => string) {
	return (args: TArgs, theme: Theme, ctx: RenderCtx): Component => {
		const text = getText(ctx.lastComponent);
		if (
			hideCollapsedToolCall(ctx.state as CollapseState, ctx.expanded, (value) =>
				text.setText(value),
			)
		)
			return text;
		const arg = pickArg(args);
		text.setText(`${theme.fg("toolTitle", theme.bold(title))} ${theme.fg("dim", arg)}`);
		return text;
	};
}

/** Build a `renderResult` with a bounded detail preview and optional compact terminal row. */
export function makeRenderResult<TDetails>(config?: CompactRendererConfig<TDetails>) {
	return (
		result: AgentToolResult<unknown>,
		opts: ToolRenderResultOptions,
		theme: Theme,
		ctx: RenderCtx,
	): Component => {
		const body = allText(result);

		if (ctx.isError || !body.trim()) {
			const text = getText(ctx.lastComponent);
			text.setText(
				`${BODY_PAD}${ctx.isError ? theme.fg("error", body || "Error") : theme.fg("muted", "(empty)")}`,
			);
			return opts.isPartial ? text : frameToolResult(text, theme, ctx.isError);
		}

		const details = result.details as TDetails | undefined;
		const isError = Boolean(details && config?.status?.(details) === "error");
		if (
			!opts.isPartial &&
			config &&
			details &&
			tickCollapse(config.tool, ctx.state as CollapseState, ctx.invalidate, opts.expanded)
		) {
			const text = getText(ctx.lastComponent);
			text.setText(
				formatCollapsedToolRow(
					theme,
					config.tool,
					config.target(details),
					config.meta(details),
					config.status?.(details) ?? "success",
				),
			);
			return text;
		}

		if (opts.isPartial || isError) {
			const text = getText(ctx.lastComponent);
			text.setText(dimBody(body, theme, opts.expanded));
			return opts.isPartial ? text : frameToolResult(text, theme, isError);
		}
		const lines = body.split("\n");
		const preview = opts.expanded ? body : lines.slice(0, MAX_PREVIEW_LINES).join("\n");
		const remaining = lines.length - MAX_PREVIEW_LINES;
		const markdown = new Markdown(
			remaining > 0 && !opts.expanded ? `… ${remaining} more lines\n\n${preview}` : preview,
			2,
			0,
			getMarkdownTheme(),
			{ color: (value) => theme.fg("dim", value) },
		);
		return frameToolResult(markdown, theme, false);
	};
}
