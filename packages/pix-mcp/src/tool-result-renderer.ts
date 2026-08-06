import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { MAX_PREVIEW_LINES } from "@xynogen/pix-pretty/config";
import { hlBlock } from "@xynogen/pix-pretty/highlight";
import { formatJson, renderCollapsedToolRow } from "@xynogen/pix-pretty/utils";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";

type McpToolResultDetails = Record<string, unknown> & { error?: unknown };
type McpToolContentBlock = AgentToolResult<McpToolResultDetails>["content"][number];

interface RenderTheme {
	fg: (name: string, text: string) => string;
	bold?: (text: string) => string;
}

/** The render context Pi passes as renderResult's 4th arg. */
interface McpRenderCtx {
	isError?: boolean;
	expanded?: boolean;
	// CollapseState plus async-highlight cache slots for each rendered surface.
	state?: CollapseState & HlState;
	invalidate?: () => void;
}

/**
 * True when the block looks like a JSON object/array — worth highlighting.
 * Structural check only (no JSON.parse): a truncated preview is cut mid-object
 * and would never fully parse, but cli-highlight colors partial JSON fine
 * (ignoreIllegals), so a full parse would wrongly disable highlighting on
 * exactly the large results that need it.
 */
function looksLikeJson(text: string): boolean {
	const t = text.trimStart();
	return t[0] === "{" || t[0] === "[";
}

type HighlightSlot = { key: string; text?: string };
type HlState = { _highlights?: Record<string, HighlightSlot> };

// JSON syntax-highlight like read/edit. Each surface owns a cache slot because
// Pi renders tool calls and results with the same context state. Sharing one
// key makes both renderers invalidate each other forever when restoring history.
function highlightedJson(
	body: string,
	surface: string,
	state: HlState,
	invalidate: () => void,
	theme: RenderTheme,
): string | null {
	if (!body || !looksLikeJson(body)) return null;
	const key = `${body.length}:${body}`;
	state._highlights ??= {};
	const highlights = state._highlights;
	let slot = highlights[surface];
	if (slot?.key !== key) {
		slot = { key };
		highlights[surface] = slot;
		hlBlock(body, "json", theme)
			.then((styled) => {
				if (highlights[surface] !== slot) return;
				slot.text = styled.join("\n");
				invalidate();
			})
			.catch(() => {});
	}
	return slot.text ?? null;
}

export interface McpProxyToolCallInput {
	tool?: string;
	args?: string;
	connect?: string;
	describe?: string;
	search?: string;
	regex?: boolean;
	includeSchemas?: boolean;
	server?: string;
	action?: string;
}

export interface McpToolResultDisplay {
	lines: string[];
	truncated: boolean;
}

const DEFAULT_MAX_CALL_INPUT_CHARS = 1500;
// Hard per-line width for the mega-line guard. Typical pretty-printed JSON is
// already short-lined, so this only bites a pathological one-liner (e.g. a
// multi-KB single line) whose per-line measure cost would saturate the TUI.
const CALL_WRAP_WIDTH = 200;

function formatJsonish(value: unknown, maxChars: number): string {
	return formatJson(value, {
		maxChars,
		maxLines: MAX_PREVIEW_LINES,
		wrapWidth: CALL_WRAP_WIDTH,
	});
}

function hasUsefulObjectContent(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.keys(value).length > 0
	);
}

export function formatMcpProxyToolCallLines(
	args: McpProxyToolCallInput,
	maxInputChars = DEFAULT_MAX_CALL_INPUT_CHARS,
): string[] {
	if (args.action === "ui-messages") return [`mcp ${args.action}`];

	if (args.tool) {
		const target = args.server ? `${args.tool} @ ${args.server}` : args.tool;
		const lines = [`mcp call ${target}`];
		if (args.args) lines.push(formatJsonish(args.args, maxInputChars));
		return lines;
	}

	if (args.connect) return [`mcp connect ${args.connect}`];
	if (args.describe) return [`mcp describe ${args.describe}`];

	if (args.search) {
		let line = `mcp search ${args.search}`;
		if (args.server) line += ` @ ${args.server}`;
		if (args.regex === true) line += " (regex)";
		if (args.includeSchemas === false) line += " (schemas hidden)";
		return [line];
	}

	if (args.server) return [`mcp list ${args.server}`];
	if (args.action) return [`mcp ${args.action}`];

	return ["mcp status"];
}

export function formatMcpDirectToolCallLines(
	displayName: string,
	args: Record<string, unknown>,
	maxInputChars = DEFAULT_MAX_CALL_INPUT_CHARS,
): string[] {
	if (!hasUsefulObjectContent(args)) return [displayName];
	return [displayName, formatJsonish(args, maxInputChars)];
}

function renderToolCallLines(lines: string[], theme: RenderTheme, ctx?: McpRenderCtx) {
	// Once the result collapses to its one-row summary, the call row (title +
	// JSON args) is redundant — blank it so only the `✓ mcp <tool> · N lines`
	// summary remains, matching bash/read. Expanding restores the full call.
	if (ctx?.state?.collapsed && !ctx.expanded) return new Text("", 0, 0);

	const [title = "mcp", ...rest] = lines;
	const styledTitle = theme.fg("toolTitle", theme.bold ? theme.bold(title) : title);

	// The trailing lines are a pretty-printed JSON args block; highlight it.
	if (ctx?.state && ctx.invalidate) {
		const hl = highlightedJson(rest.join("\n"), "mcpcall", ctx.state, ctx.invalidate, theme);
		if (hl) return new Text([styledTitle, hl].join("\n"), 0, 0);
	}

	const styledRest = rest.map((line) => theme.fg("muted", line));
	return new Text([styledTitle, ...styledRest].join("\n"), 0, 0);
}

export function renderMcpProxyToolCall(
	args: McpProxyToolCallInput,
	theme: RenderTheme,
	ctx?: McpRenderCtx,
) {
	return renderToolCallLines(formatMcpProxyToolCallLines(args), theme, ctx);
}

export function createMcpDirectToolCallRenderer(displayName: string) {
	return (args: Record<string, unknown>, theme: RenderTheme, ctx?: McpRenderCtx) => {
		return renderToolCallLines(formatMcpDirectToolCallLines(displayName, args), theme, ctx);
	};
}

// A JSON tool result is pretty-formatted (one mega-line → many short lines) so
// the pathological single-line case that saturates the TUI render loop can
// never reach the measurer. Long JSON *string values* stay on one logical line
// (wrapping them mid-token would break highlighting); the preview clips each
// line to the terminal width at render time (see clipToWidth), exactly like
// pix-read, so one logical line is always one screen row and the line cap is a
// row cap. No cap here — formatMcpToolResultLines owns the preview cap and
// expanded must stay complete.
function blockToLines(block: McpToolContentBlock): string[] {
	if (block.type === "text") {
		return formatJson(block.text, { maxLines: Number.MAX_SAFE_INTEGER }).split("\n");
	}
	return [`[image: ${block.mimeType}]`];
}

// A component that clips each line to the viewport width at render time so one
// logical line is always one screen row (like pix-read's truncateToWidth).
// Without this, pi-tui wraps a long JSON string value across many rows and a
// single fat value blows past the row cap into a tall blob. Used for the preview
// only — expanded uses plain Text so it wraps and shows everything.
class ClippedLines {
	constructor(private readonly text: string) {}
	invalidate(): void {}
	render(width: number): string[] {
		const lines = this.text.split("\n");
		if (width <= 0) return lines;
		return lines.map((line) => truncateToWidth(line, width, "›"));
	}
}

function separated(content: Text | ClippedLines, theme: RenderTheme) {
	return {
		invalidate: () => content.invalidate(),
		render: (width: number) => [
			theme.fg("muted", "─".repeat(Math.max(0, width))),
			...content.render(width),
		],
	};
}

// Collapsed MCP results reuse MAX_PREVIEW_LINES — the same preview cap bash and
// read use — instead of a bespoke MCP knob. Expanding always shows everything.
export function formatMcpToolResultLines(
	result: Pick<AgentToolResult<McpToolResultDetails>, "content">,
	expanded: boolean,
	maxCollapsedLines = MAX_PREVIEW_LINES,
): McpToolResultDisplay {
	const allLines = result.content.flatMap(blockToLines);
	const lines = allLines.length > 0 ? allLines : ["(empty result)"];

	if (expanded || lines.length <= maxCollapsedLines) {
		return { lines, truncated: false };
	}

	const hidden = lines.length - maxCollapsedLines;
	return {
		lines: [...lines.slice(0, maxCollapsedLines), `… +${hidden} more`],
		truncated: true,
	};
}

/** Build a collapsed one-row summary: `✓ mcp <tool@server> · N lines`. */
function collapsedRow(
	result: AgentToolResult<McpToolResultDetails>,
	theme: RenderTheme & { bold: (text: string) => string },
): string {
	const d = result.details as Record<string, unknown>;
	const tool = typeof d.tool === "string" ? d.tool : "";
	const server = typeof d.server === "string" ? d.server : "";
	let target = tool;
	if (tool && server) target = `${tool} @ ${server}`;
	else if (!tool) target = server;
	const lineCount = result.content.flatMap(blockToLines).length;
	const meta = lineCount > 0 ? `${lineCount} ${lineCount === 1 ? "line" : "lines"}` : "";
	return renderCollapsedToolRow(theme, "mcp", target, meta);
}

export function renderMcpToolResult(
	result: AgentToolResult<McpToolResultDetails>,
	options: ToolRenderResultOptions,
	theme: RenderTheme,
	context?: McpRenderCtx,
) {
	if (options.isPartial) {
		return new Text(theme.fg("warning", "Running MCP tool..."), 0, 0);
	}

	const hasErrorDetails = Boolean(result.details.error);
	const isError = context?.isError === true || hasErrorDetails;

	// Auto-collapse to a summary row after the delay, like bash/read. Errors are
	// never collapsed (the timer is skipped so the failure stays visible).
	if (!isError && context?.state && context.invalidate && theme.bold) {
		const withBold = theme as RenderTheme & { bold: (text: string) => string };
		if (tickCollapse("mcp", context.state, context.invalidate, options.expanded)) {
			return new Text(collapsedRow(result, withBold), 0, 0);
		}
	}

	const display = formatMcpToolResultLines(result, options.expanded || isError);
	const hint =
		display.truncated && !options.expanded ? `\n${theme.fg("muted", "(Ctrl+O to expand)")}` : "";

	// cli-highlight the JSON body — both the preview and the expanded view.
	// Highlighted JSON is ANSI-dense, which used to be too costly: an unshaped
	// mega-line forced pi-tui off its ASCII fast-path and re-highlighting it each
	// spinner frame saturated the render thread. blockToLines now pretty-formats
	// and hard-wraps the body first, so the highlighted set is small and bounded
	// (~0.9ms/frame even at the full 80-line preview) — affordable to highlight.
	// A truncated preview is highlighted too: split off the muted "+N more"
	// footer so it stays on the plain path, and highlight only the body lines
	// above it. (Highlighting the whole result was the win the mega-line shaping
	// bought back; skipping it on truncation left large results plain.)
	if (context?.state && context.invalidate) {
		const body = display.truncated ? display.lines.slice(0, -1) : display.lines;
		const footer = display.truncated ? display.lines.at(-1) : undefined;
		const hl = highlightedJson(
			body.join("\n"),
			`mcp:${options.expanded ? "full" : "preview"}`,
			context.state,
			context.invalidate,
			theme,
		);
		if (hl) {
			const footerLine = footer ? `\n${theme.fg("muted", footer)}` : "";
			const styled = `${hl}${footerLine}${hint}`;
			// Preview clips each line to one row; expanded wraps to show everything.
			return separated(options.expanded ? new Text(styled, 0, 0) : new ClippedLines(styled), theme);
		}
	}

	const output = display.lines
		.map((line, i) =>
			display.truncated && i === display.lines.length - 1
				? theme.fg("muted", line)
				: theme.fg("toolOutput", line),
		)
		.join("\n");

	const styled = `${output}${hint}`;
	return separated(options.expanded ? new Text(styled, 0, 0) : new ClippedLines(styled), theme);
}
