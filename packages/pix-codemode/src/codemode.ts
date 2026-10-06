import type {
	AgentToolResult,
	ToolDefinition,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { resolveBaseBackground } from "@xynogen/pix-pretty/ansi";
import { commandPreview } from "@xynogen/pix-pretty/command-preview";
import { MAX_PREVIEW_LINES } from "@xynogen/pix-pretty/config";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import type { TextComponentLike, ThemeLike } from "@xynogen/pix-pretty/types";
import {
	dotJoin,
	formatJson,
	formatToolCallTitle,
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
	result?: AgentToolResult<unknown> & { isError?: boolean; structuredContent?: unknown };
};
type Details = { calls?: Call[]; fullOutputPath?: string };
type Renderers = Pick<ToolDefinition, "renderCall" | "renderResult" | "renderShell">;

export function compactRow(
	call: Pick<Call, "name" | "args" | "status" | "durationMs" | "cost">,
	theme: Pick<ThemeLike, "fg"> | Parameters<NonNullable<ToolDefinition["renderCall"]>>[1],
	expanded = false,
) {
	const [key, role] = {
		ok: ["status.ok", "success"],
		error: ["status.error", "error"],
		running: ["status.running", "warning"],
		cancelled: ["status.blocked", "muted"],
	}[call.status] as [Parameters<typeof icon>[0], "success" | "error" | "warning" | "muted"];
	const args = !expanded && call.args.length > 80 ? `${call.args.slice(0, 77)}...` : call.args;
	return dotJoin(
		[
			`${theme.fg(role, padIcon(icon(key)))} ${theme.fg("toolTitle", call.name)} ${theme.fg("dim", args)}`,
			call.durationMs === undefined ? "" : theme.fg("muted", formatMs(call.durationMs)),
			call.cost ? theme.fg("muted", costText(call.cost)) : "",
		],
		(text) => theme.fg("muted", text),
	);
}

export function compactRenderers(
	name: string,
	native: Renderers | undefined,
	duration: (id: string) => number | undefined,
): Renderers {
	return {
		renderShell: "self",
		renderCall(args, theme, ctx) {
			if (ctx.expanded && native?.renderCall) {
				const component = native.renderCall(args, theme, {
					...ctx,
					lastComponent: ctx.state.compactCall,
				});
				ctx.state.compactCall = component;
				return component;
			}
			return new Text(
				ctx.isPartial || ctx.expanded
					? compactRow(
							{
								name,
								args: JSON.stringify(args) ?? "",
								status: ctx.isPartial ? "running" : ctx.isError ? "error" : "ok",
							},
							theme,
							ctx.expanded,
						)
					: "",
				0,
				0,
			);
		},
		renderResult(result, options, theme, ctx) {
			if (options.expanded) {
				if (native?.renderResult) {
					const component = native.renderResult(result, options, theme, {
						...ctx,
						lastComponent: ctx.state.compactResult,
					});
					ctx.state.compactResult = component;
					return component;
				}
				const text = new Text(
					result.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n"),
					0,
					0,
				);
				return options.isPartial ? text : frameToolResult(text, theme, ctx.isError);
			}
			ctx.state.compactDuration = duration(ctx.toolCallId) ?? ctx.state.compactDuration;
			return new Text(
				options.isPartial
					? ""
					: compactRow(
							{
								name,
								args: JSON.stringify(ctx.args) ?? "",
								status: ctx.isError ? "error" : "ok",
								durationMs: ctx.state.compactDuration,
							},
							theme,
						),
				0,
				0,
			);
		},
	};
}
type State = CollapseState & Record<string, unknown>;
type Context = {
	state: State;
	expanded: boolean;
	isError?: boolean;
	isPartial?: boolean;
	executionStarted?: boolean;
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
		`${formatToolCallTitle(theme, "codemode", ctx)}`,
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
				const value = JSON.parse(text);
				// ponytail: unwrap only the native command envelope. Unknown fields and batch wrappers stay JSON.
				if (
					value !== null &&
					!Array.isArray(value) &&
					typeof value.output === "string" &&
					typeof value.truncated === "boolean" &&
					Number.isSafeInteger(value.exit_code) &&
					typeof value.wall_time_seconds === "number" &&
					Number.isFinite(value.wall_time_seconds) &&
					value.wall_time_seconds >= 0 &&
					(value.full_output_path === undefined || typeof value.full_output_path === "string") &&
					Object.keys(value).every((key) =>
						["output", "truncated", "exit_code", "wall_time_seconds", "full_output_path"].includes(
							key,
						),
					)
				) {
					failed ||= value.exit_code !== 0;
					return {
						text: value.output,
						json: false,
						metadata: dotJoin([
							`exit ${value.exit_code}`,
							`command ${formatMs(value.wall_time_seconds * 1000)}`,
							`truncated: ${value.truncated}`,
						]),
						fullOutputPath: value.full_output_path as string | undefined,
					};
				}
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
	const compactPreview = !options.expanded && !isError && calls.some((call) => call.result);
	const rows: string[] = [];
	if (!options.isPartial && compactPreview && (wall || cost))
		rows.push(
			dotJoin([
				formatToolCallTitle(theme, "codemode", ctx),
				theme.fg("muted", dotJoin([wall, cost ? costText(cost) : ""])),
			]),
		);
	const nestedTexts: { text: string; metadata?: string; fullOutputPath?: string }[] = [];
	const shown = options.expanded ? calls : calls.slice(-8);
	if (shown.length < calls.length)
		rows.push(`    ${theme.fg("muted", `… +${calls.length - shown.length} earlier calls`)}`);
	for (const call of shown) {
		rows.push(`    ${compactRow(call, theme, options.expanded)}`);
		if (options.expanded && call.result) {
			const nestedOutput = output(
				(call.name === "bash" || call.name === "powershell") && call.result.structuredContent
					? {
							content: [{ type: "text", text: JSON.stringify(call.result.structuredContent) }],
							details: {},
						}
					: (call.result as AgentToolResult<Details>),
			);
			for (const block of nestedOutput.blocks) {
				nestedTexts.push(block);
				for (const line of block.text.split("\n")) {
					rows.push(`       ${theme.fg(call.result.isError ? "error" : "toolOutput", line)}`);
				}
				if (block.metadata) rows.push(`       ${theme.fg("muted", block.metadata)}`);
				if (block.fullOutputPath)
					rows.push(`       ${theme.fg("muted", `Full output: ${block.fullOutputPath}`)}`);
			}
		}
		if (options.expanded && call.error && !call.result) {
			for (const errLine of call.error.split("\n")) {
				rows.push(`      ${theme.fg("error", errLine)}`);
			}
		}
	}
	const outputStart = rows.length;
	// ponytail: hide duplicate script output only in successful child-result previews. Expansion keeps every block.
	const scriptBlocks = display.blocks.filter((block) => {
		if (compactPreview) return false;
		const index = nestedTexts.findIndex(
			(nested) =>
				nested.text === block.text &&
				nested.metadata === block.metadata &&
				nested.fullOutputPath === block.fullOutputPath,
		);
		if (!block.text || index < 0) return true;
		nestedTexts.splice(index, 1);
		return false;
	});
	if (!options.isPartial) {
		if (calls.some((call) => call.result) && scriptBlocks.some((block) => block.text))
			rows.push(theme.fg("muted", "Script output"));
		for (const block of scriptBlocks) {
			if (!block.text && !block.metadata) continue;
			if (block.json) rows.push(...highlightJson(block.text, theme).split("\n"));
			else {
				let errorBlock = false;
				for (const line of block.text.split("\n")) {
					errorBlock ||= line.startsWith("Script error:");
					rows.push(theme.fg(errorBlock ? "error" : "toolOutput", line));
				}
			}
			if (block.metadata) rows.push(theme.fg("muted", block.metadata));
			if (block.fullOutputPath)
				rows.push(theme.fg("muted", `Full output: ${block.fullOutputPath}`));
		}
		if (!compactPreview && (wall || cost))
			rows.push(theme.fg("muted", dotJoin([wall, cost ? costText(cost) : ""])));
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
	// ponytail: script output stays in one section. Do not guess which nested call produced it.
	if (calls.length > 0) {
		for (let i = outputStart; i < preview.length; i++) preview[i] = `       ${preview[i]}`;
	}
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
