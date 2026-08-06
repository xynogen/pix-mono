import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
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
	// CollapseState plus our own async-highlight cache slots (mirrors pix-read).
	state?: CollapseState & { _hlKey?: string; _hlText?: string };
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

type HlState = { _hlKey?: string; _hlText?: string };

// JSON syntax-highlight like read/edit. hlBlock is async, so schedule it in the
// background, cache the styled text on the render state, and invalidate to
// repaint once ready. Returns the cached highlighted text, or null until it
// resolves (or when `body` isn't JSON) so the caller falls back to plain style.
function highlightedJson(
	body: string,
	keyPrefix: string,
	state: HlState,
	invalidate: () => void,
	theme: RenderTheme,
): string | null {
	if (!body || !looksLikeJson(body)) return null;
	const key = `${keyPrefix}:${body.length}:${body}`;
	if (state._hlKey !== key) {
		state._hlKey = key;
		hlBlock(body, "json", theme)
			.then((styled) => {
				if (state._hlKey !== key) return;
				state._hlText = styled.join("\n");
				invalidate();
			})
			.catch(() => {});
	}
	return state._hlText ?? null;
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

// Result-body line width. A JSON tool result is pretty-formatted (one mega-line
// → many short lines) and any remaining long line is hard-wrapped, so the
// pathological single-line case that saturates the TUI render loop can never
// reach the measurer. No line/char cap here — formatMcpToolResultLines owns the
// preview cap, and expanded must stay complete.
const RESULT_WRAP_WIDTH = 200;

function blockToLines(block: McpToolContentBlock): string[] {
	if (block.type === "text") {
		return formatJson(block.text, {
			wrapWidth: RESULT_WRAP_WIDTH,
			maxLines: Number.MAX_SAFE_INTEGER,
		}).split("\n");
	}
	return [`[image: ${block.mimeType}]`];
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
			return new Text(`${hl}${footerLine}${hint}`, 0, 0);
		}
	}

	const output = display.lines
		.map((line, i) =>
			display.truncated && i === display.lines.length - 1
				? theme.fg("muted", line)
				: theme.fg("toolOutput", line),
		)
		.join("\n");

	return new Text(`${output}${hint}`, 0, 0);
}
