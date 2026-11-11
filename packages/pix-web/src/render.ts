/** Render web results as Markdown in the transcript without changing model content. */

import { fadeRowsOf } from "@xynogen/pix-pretty/text";
import {
	Box,
	type Component,
	getMarkdownTheme,
	Markdown,
	Text,
	type Theme,
	type ToolRenderResultOptions,
} from "@xynogen/pix-pretty/tui";
import {
	BODY_PAD,
	bodyLine,
	type CollapsedToolStatus,
	frameToolResult,
	getTextContent,
	moreLines,
	renderRow,
	unframeToolResult,
} from "@xynogen/pix-pretty/utils";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";
import type { AgentToolResult } from "@xynogen/pix-runtime/host";

interface TextLike extends Component {
	setText(text: string): void;
}

// ToolRenderContext is not re-exported by pi-coding-agent; model the fields the
// renderers actually read. Structurally compatible with the SDK context.
interface RenderCtx {
	executionStarted?: boolean;
	isPartial?: boolean;
	lastComponent: Component | undefined;
	isError: boolean;
	state: Record<string, unknown>;
	expanded: boolean;
	invalidate: () => void;
	keyHint?: (keybinding: "app.tools.expand", description: string) => string;
}

interface CompactRendererConfig<TDetails> {
	tool: string;
	target: (details: TDetails) => string;
	meta: (details: TDetails) => string;
	status?: (details: TDetails) => CollapsedToolStatus;
}

// Preview budget in rendered rows; the last few fade out. Expand shows the full page.
const MAX_PREVIEW_LINES = 16;

function getText(lastComponent: Component | undefined): TextLike {
	const component = lastComponent && unframeToolResult(lastComponent as TextLike);
	return component instanceof Text ? component : new Text("", 0, 0);
}

function dimBody(body: string, theme: Theme, ctx: RenderCtx, expanded: boolean): string {
	const lines = body.split("\n");
	const maxShow = expanded ? lines.length : MAX_PREVIEW_LINES;
	const out = fadeRowsOf(
		lines.slice(0, maxShow + 1).map((line) => bodyLine(line, theme, (l) => theme.fg("dim", l))),
		theme,
		maxShow,
	);
	const remaining = lines.length - maxShow;
	if (remaining > 0) out.push(moreLines(remaining, theme, ctx));
	return out.join("\n");
}

/** Build a `renderResult` with a bounded detail preview and optional compact terminal row. */
export function makeRenderResult<TDetails>(config?: CompactRendererConfig<TDetails>) {
	return (
		result: AgentToolResult<unknown>,
		opts: ToolRenderResultOptions,
		theme: Theme,
		ctx: RenderCtx,
	): Component => {
		const body = getTextContent(result);

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
				renderRow(
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
			text.setText(dimBody(body, theme, ctx, opts.expanded));
			return opts.isPartial ? text : frameToolResult(text, theme, isError);
		}
		const bodyView = new Box(0, 0);
		const markdown = new Markdown(body, 3, 0, getMarkdownTheme(), {
			color: (value) => theme.fg("dim", value),
		});
		if (opts.expanded) bodyView.addChild(markdown);
		// Fade the last preview rows of the rendered page instead of a hard cut.
		else
			bodyView.addChild({
				invalidate: () => markdown.invalidate(),
				render: (width: number) => {
					const rows = markdown.render(width);
					const hidden = rows.length - MAX_PREVIEW_LINES;
					const shown = fadeRowsOf(rows, theme, MAX_PREVIEW_LINES);
					return hidden > 0 ? [...shown, moreLines(hidden, theme, ctx)] : shown;
				},
			});
		return frameToolResult(bodyView, theme, false);
	};
}
