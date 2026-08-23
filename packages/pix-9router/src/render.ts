/**
 * render.ts — shared dim renderers for fetch/search tool output.
 *
 * fetch/search return external web content the model already consumed; the
 * full body is noise in the transcript. We render it dim (theme `dim` token)
 * so it reads like faded reasoning — present for inspection, visually quiet.
 * The tool title line stays normal so calls remain scannable.
 *
 * pi-tui's Text component is loaded via require() so the renderers degrade to
 * the default pi renderer (undefined-safe via cast) when pi-tui is absent.
 */

import type {
	AgentToolResult,
	Theme,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
	type CollapsedToolStatus,
	formatCollapsedToolRow,
	hideCollapsedToolCall,
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

type TextCtor = new (text?: string, padX?: number, padY?: number) => TextLike;

// Preview cap is intentionally generous — dimming already de-emphasises the
// body, so we only truncate to keep pathological multi-thousand-line dumps
// from flooding the viewport. Expanding shows everything.
const MAX_PREVIEW_LINES = 32;

let TextComponent: TextCtor | undefined;
try {
	TextComponent = (require("@earendil-works/pi-tui") as { Text: TextCtor }).Text;
} catch {
	TextComponent = undefined;
}

function getText(lastComponent: Component | undefined): TextLike {
	if (lastComponent && "setText" in lastComponent) return lastComponent as TextLike;
	// TextComponent is always present in the interactive TUI (pi-tui peer); the
	// require() guard only matters for headless/test contexts where renderers
	// are never invoked.
	if (TextComponent) return new TextComponent("", 0, 0);
	throw new Error("pi-tui Text component unavailable");
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
	const out = shown.map((line) => `  ${theme.fg("dim", line)}`);
	const remaining = lines.length - maxShow;
	if (remaining > 0) {
		out.push(`  ${theme.fg("dim", `… ${remaining} more lines`)}`);
	}
	return out.join("\n");
}

/** Build a `renderCall` that shows `<title> <accent arg>`. */
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
		text.setText(`${theme.fg("toolTitle", theme.bold(title))} ${theme.fg("muted", arg)}`);
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
		const text = getText(ctx.lastComponent);
		const body = allText(result);

		if (ctx.isError) {
			text.setText(`  ${theme.fg("error", body || "Error")}`);
			return text;
		}
		if (!body.trim()) {
			text.setText(`  ${theme.fg("dim", "(empty)")}`);
			return text;
		}

		const details = result.details as TDetails | undefined;
		if (
			!opts.isPartial &&
			config &&
			details &&
			tickCollapse(config.tool, ctx.state as CollapseState, ctx.invalidate, opts.expanded)
		) {
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

		text.setText(dimBody(body, theme, opts.expanded));
		return text;
	};
}
