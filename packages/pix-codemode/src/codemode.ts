import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { resolveBaseBackground } from "@xynogen/pix-pretty/ansi";
import { commandPreview } from "@xynogen/pix-pretty/command-preview";
import { MAX_PREVIEW_LINES } from "@xynogen/pix-pretty/config";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import type { TextComponentLike, ThemeLike } from "@xynogen/pix-pretty/types";
import {
	dotJoin,
	formatJson,
	frameToolResult,
	hideCollapsedToolCall,
	padIcon,
	pluralize,
	renderCollapsedToolRow,
	unframeToolResult,
	viewportTextConstructor,
} from "@xynogen/pix-pretty/utils";
import { formatMs } from "@xynogen/pix-pretty/widget-format";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";

type Call = {
	id: string;
	name: string;
	args: string;
	status: "running" | "ok" | "error" | "cancelled";
	durationMs?: number;
	error?: string;
	cost?: number;
};
type Details = { calls?: Call[]; fullOutputPath?: string };
type State = CollapseState & Record<string, unknown>;
type Context = {
	state: State;
	expanded: boolean;
	isError?: boolean;
	invalidate: () => void;
	lastComponent?: TextComponentLike;
};
const PreviewText = viewportTextConstructor(Text);
const costText = (cost: number) => `$${cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2)}`;

// ponytail: JSON.parse validates the block first. Color JSON tokens directly,
// so long strings do not need the general highlighter's backtracking guard.
function highlightJson(text: string, theme: ThemeLike): string {
	return text.replace(
		/"(?:\\[\s\S]|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b|[{}[\],:]/g,
		(token, offset: number) => {
			const role = token.startsWith('"')
				? /^\s*:/.test(text.slice(offset + token.length))
					? "syntaxVariable"
					: "syntaxString"
				: /^[\d-]/.test(token)
					? "syntaxNumber"
					: /^(true|false|null)$/.test(token)
						? "syntaxKeyword"
						: "syntaxPunctuation";
			return theme.fg(role, token);
		},
	);
}

export function renderCall(args: { code?: string }, theme: ThemeLike, ctx: Context) {
	resolveBaseBackground(theme);
	const text = new PreviewText();
	if (hideCollapsedToolCall(ctx.state, ctx.expanded, (value) => text.setText(value))) return text;
	const code = typeof args.code === "string" ? args.code : "[invalid arg]";
	return commandPreview(
		`${theme.fg("warning", padIcon(icon("status.running")))} ${theme.fg("toolTitle", theme.bold("codemode"))}`,
		code,
		"javascript",
		theme,
		ctx.state,
		ctx.invalidate,
		ctx.expanded,
		3,
	);
}

function output(result: AgentToolResult<Details>) {
	let wallTime: number | undefined;
	let failed = false;
	const blocks = result.content.map((block, index) => {
		if (block.type !== "text") return { text: `[image: ${block.mimeType}]`, json: false };
		let text = block.text;
		if (index === 0) {
			// ponytail: parse the current host header. Unknown headers remain unchanged.
			const header = /^Script (completed|failed)\nWall time ([\d.]+) seconds\nOutput:\n/.exec(text);
			if (header) {
				wallTime = Number(header[2]);
				failed = header[1] === "failed";
				text = text.slice(header[0].length);
			}
		}
		let json = false;
		if (/^[[{]/.test(text.trimStart())) {
			try {
				JSON.parse(text);
				json = true;
				text = formatJson(text, { maxLines: Number.MAX_SAFE_INTEGER });
			} catch {
				// Preserve incomplete JSON and ordinary text exactly.
			}
		}
		return { text, json };
	});
	return { blocks, wallTime, failed };
}

export function renderResult(
	result: AgentToolResult<Details>,
	options: ToolRenderResultOptions,
	theme: ThemeLike,
	ctx: Context,
) {
	resolveBaseBackground(theme);
	const calls = result.details?.calls ?? [];
	const display = output(result);
	const isError =
		ctx.isError === true ||
		display.failed ||
		display.blocks.some((b) => /^Script error:/m.test(b.text));
	if (isError) {
		if (ctx.state.timer) clearTimeout(ctx.state.timer);
		ctx.state.timer = undefined;
		ctx.state.collapsed = false;
	}
	const lineCount = display.blocks.reduce(
		(sum, b) => sum + (b.text ? b.text.split("\n").length : 0),
		0,
	);
	const cost = calls.reduce((sum, call) => sum + (call.cost ?? 0), 0);
	const wall = display.wallTime === undefined ? "" : formatMs(display.wallTime * 1000);
	if (
		!options.isPartial &&
		!isError &&
		tickCollapse("codemode", ctx.state, ctx.invalidate, options.expanded)
	) {
		const counts = new Map<string, number>();
		for (const call of calls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
		const names = [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name));
		return new Text(
			renderCollapsedToolRow(
				theme,
				"codemode",
				dotJoin(names),
				dotJoin([
					pluralize(calls.length, "call"),
					pluralize(lineCount, "line"),
					wall,
					cost ? costText(cost) : "",
				]),
			),
			0,
			0,
		);
	}
	const rows: string[] = [];
	const shown = options.expanded ? calls : calls.slice(-8);
	if (shown.length < calls.length)
		rows.push(theme.fg("muted", `… +${calls.length - shown.length} earlier calls`));
	for (const call of shown) {
		const status = {
			ok: ["status.ok", "success"],
			error: ["status.error", "error"],
			running: ["status.running", "warning"],
			cancelled: ["status.blocked", "muted"],
		} as const;
		const [key, role] = status[call.status];
		rows.push(
			dotJoin(
				[
					`${theme.fg(role, icon(key))} ${theme.fg("toolTitle", call.name)} ${theme.fg("dim", call.args)}`,
					call.durationMs === undefined ? "" : theme.fg("muted", formatMs(call.durationMs)),
					call.cost ? theme.fg("muted", costText(call.cost)) : "",
				],
				(s) => theme.fg("muted", s),
			),
		);
		if (call.error) rows.push(theme.fg("error", call.error));
	}
	if (!options.isPartial) {
		for (const block of display.blocks) {
			if (!block.text) continue;
			if (block.json) rows.push(...highlightJson(block.text, theme).split("\n"));
			else {
				let errorBlock = false;
				for (const line of block.text.split("\n")) {
					errorBlock ||= line.startsWith("Script error:");
					rows.push(theme.fg(errorBlock ? "error" : "toolOutput", line));
				}
			}
		}
		if (wall || cost) rows.push(theme.fg("muted", dotJoin([wall, cost ? costText(cost) : ""])));
	}
	const preview =
		!options.expanded && rows.length > MAX_PREVIEW_LINES
			? [
					...rows.slice(0, MAX_PREVIEW_LINES),
					theme.fg("muted", `… +${rows.length - MAX_PREVIEW_LINES} lines`),
				]
			: rows;
	if (result.details?.fullOutputPath)
		preview.push(theme.fg("muted", `Full output: ${result.details.fullOutputPath}`));
	const prior = ctx.lastComponent ? unframeToolResult(ctx.lastComponent) : undefined;
	// ponytail: the preview cap counts logical lines. Long values wrap in full.
	// Add a visual-line viewport if wrapped payloads need a separate height limit.
	const text = options.expanded ? new Text("", 0, 0) : (prior ?? new Text("", 0, 0));
	text.setText(
		preview.join("\n") ||
			theme.fg("muted", options.isPartial ? "Running script..." : "(empty output)"),
	);
	return options.isPartial ? text : frameToolResult(text, theme, isError);
}
