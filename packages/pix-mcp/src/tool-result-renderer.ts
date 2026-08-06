import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { MAX_PREVIEW_LINES } from "@xynogen/pix-pretty/config";
import { renderCollapsedToolRow } from "@xynogen/pix-pretty/utils";
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
	state?: CollapseState;
	invalidate?: () => void;
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

function truncateText(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

// The call row has no expand affordance, so cap by BOTH chars (guards a single
// huge line) and lines (guards a tall pretty-printed object), mirroring the
// collapsed result view. Line cap reuses MAX_PREVIEW_LINES.
function capBlock(text: string, maxChars: number): string {
	const capped = truncateText(text, maxChars);
	const lines = capped.split("\n");
	if (lines.length <= MAX_PREVIEW_LINES) return capped;
	const hidden = lines.length - MAX_PREVIEW_LINES;
	return [...lines.slice(0, MAX_PREVIEW_LINES), `… +${hidden} more`].join("\n");
}

function formatJsonish(value: unknown, maxChars: number): string {
	if (typeof value === "string") {
		try {
			return capBlock(JSON.stringify(JSON.parse(value), null, 2), maxChars);
		} catch {
			return capBlock(value, maxChars);
		}
	}

	try {
		return capBlock(JSON.stringify(value, null, 2), maxChars);
	} catch {
		return capBlock(String(value), maxChars);
	}
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

function renderToolCallLines(lines: string[], theme: RenderTheme) {
	const [title = "mcp", ...rest] = lines;
	const styledTitle = theme.fg("toolTitle", theme.bold ? theme.bold(title) : title);
	const styledRest = rest.map((line) => theme.fg("muted", line));
	return new Text([styledTitle, ...styledRest].join("\n"), 0, 0);
}

export function renderMcpProxyToolCall(args: McpProxyToolCallInput, theme: RenderTheme) {
	return renderToolCallLines(formatMcpProxyToolCallLines(args), theme);
}

export function createMcpDirectToolCallRenderer(displayName: string) {
	return (args: Record<string, unknown>, theme: RenderTheme) => {
		return renderToolCallLines(formatMcpDirectToolCallLines(displayName, args), theme);
	};
}

function blockToLines(block: McpToolContentBlock): string[] {
	if (block.type === "text") {
		return block.text.split("\n");
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
	const output = display.lines
		.map((line, i) =>
			display.truncated && i === display.lines.length - 1
				? theme.fg("muted", line)
				: theme.fg("toolOutput", line),
		)
		.join("\n");
	const hint =
		display.truncated && !options.expanded ? `\n${theme.fg("muted", "(Ctrl+O to expand)")}` : "";

	return new Text(`${output}${hint}`, 0, 0);
}
