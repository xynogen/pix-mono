import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { resolveBaseBackground } from "@xynogen/pix-pretty/ansi";
import { commandPreview } from "@xynogen/pix-pretty/command-preview";
import { MAX_PREVIEW_LINES } from "@xynogen/pix-pretty/config";
import { hlBlock } from "@xynogen/pix-pretty/highlight";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import type { TextComponentLike, ThemeLike } from "@xynogen/pix-pretty/types";
import {
	dotJoin,
	formatJson,
	frameToolResult,
	hideCollapsedToolCall,
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
type Slot = { key: string; theme: ThemeLike; text?: string };
type State = CollapseState & Record<string, unknown> & { highlights?: Record<string, Slot> };
type Context = {
	state: State;
	expanded: boolean;
	isError?: boolean;
	invalidate: () => void;
	lastComponent?: TextComponentLike;
};
const PreviewText = viewportTextConstructor(Text);
const costText = (cost: number) => `$${cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2)}`;

// ponytail: cache stays local until another package needs the same surface cache.
function highlight(
	code: string,
	language: string,
	surface: string,
	theme: ThemeLike,
	ctx: Context,
) {
	ctx.state.highlights ??= {};
	const cache = ctx.state.highlights;
	const key = `${language}:${code}`;
	let slot = cache[surface];
	if (slot?.key !== key || slot.theme !== theme) {
		slot = { key, theme };
		cache[surface] = slot;
		const pending = slot;
		void hlBlock(code, language, theme).then(
			(lines) => {
				if (cache[surface] !== pending) return;
				pending.text = lines.join("\n");
				ctx.invalidate();
			},
			() => {
				if (cache[surface] !== pending) return;
				pending.text = code;
				ctx.invalidate();
			},
		);
	}
	return slot.text ?? theme.fg("toolOutput", code);
}

export function renderCall(args: { code?: string }, theme: ThemeLike, ctx: Context) {
	resolveBaseBackground(theme);
	const text = new PreviewText();
	if (hideCollapsedToolCall(ctx.state, ctx.expanded, (value) => text.setText(value))) return text;
	const code = typeof args.code === "string" ? args.code : "[invalid arg]";
	return commandPreview(
		theme.fg("toolTitle", theme.bold("codemode")),
		code,
		"javascript",
		theme,
		ctx.state,
		ctx.invalidate,
		ctx.expanded,
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
		for (const [index, block] of display.blocks.entries()) {
			if (!block.text) continue;
			if (block.json)
				rows.push(...highlight(block.text, "json", `result:${index}`, theme, ctx).split("\n"));
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
	const text = options.expanded
		? new Text("", 0, 0)
		: prior instanceof Text
			? new PreviewText()
			: (prior ?? new PreviewText());
	text.setText(
		preview.join("\n") ||
			theme.fg("muted", options.isPartial ? "Running script..." : "(empty output)"),
	);
	return options.isPartial ? text : frameToolResult(text, theme, isError);
}
