import {
	AssistantMessageComponent,
	type Theme,
	truncateToWidth,
	visibleWidth,
} from "@xynogen/pix-pretty/tui";
import type { ExtensionAPI } from "@xynogen/pix-runtime/host";
import { wrapMethod } from "@xynogen/pix-runtime/patch";
import { COPY_BUTTON, type CodeFrame, forgetFrames, rememberFrames } from "./code-copy.ts";

const OPENING_FENCE_RE = /^```([^`]*)$/;
const CLOSING_FENCE_RE = /^```\s*$/;
const DEFAULT_LABEL = "code";
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const BACKGROUND_ANSI_RE = /\x1b\[(?:4[0-9]|48)(?:;[^m]*)?m/g;
const OSC_RE = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

type CodeFrameTheme = Pick<Theme, "bold" | "fg">;
type RenderMode = "tui" | "rpc" | "json" | "print";

let activeTheme: CodeFrameTheme | undefined;

/**
 * Preserve the main TUI theme when an in-process non-TUI child session starts.
 * Subagents share this module and the patched prototype with the parent; letting
 * their print/RPC session clear the theme silently disables code frames in the
 * still-running parent transcript.
 */
export function themeAfterSessionStart<T extends CodeFrameTheme>(
	current: T | undefined,
	mode: RenderMode,
	theme: T,
): T | undefined {
	return mode === "tui" ? theme : current;
}

function plainText(line: string): string {
	return line.replace(OSC_RE, "").replace(ANSI_RE, "");
}

function oscSequences(line: string): string {
	return line.match(OSC_RE)?.join("") ?? "";
}

function leadingSpaces(line: string): number {
	return plainText(line).match(/^ */)?.[0].length ?? 0;
}

function stripLayoutWhitespace(line: string, count: number): string {
	let remaining = count;
	return line
		.replace(OSC_RE, "")
		.replace(BACKGROUND_ANSI_RE, "")
		.replace(/^(?:\x1b\[[0-?]*[ -/]*[@-~]| )+/, (prefix) =>
			prefix.replace(/ /g, (space) => {
				if (remaining <= 0) return space;
				remaining--;
				return "";
			}),
		)
		.replace(/ +$/, "");
}

function fenceLabel(line: string): string | undefined {
	const match = plainText(line).trim().match(OPENING_FENCE_RE);
	if (!match) return undefined;
	const info = (match[1] ?? "").trim();
	return info.split(/\s+/, 1)[0] || DEFAULT_LABEL;
}

function topRule(width: number, language: string, theme: CodeFrameTheme): string {
	const available = Math.max(1, width - 4 - COPY_BUTTON.length);
	const displayLanguage = truncateToWidth(language, available, "…");
	const label = theme.bold(theme.fg("accent", ` ${displayLanguage} `));
	const ruleWidth = Math.max(0, width - visibleWidth(label) - 2 - COPY_BUTTON.length);
	return `${theme.fg("borderMuted", "──")}${label}${theme.fg("borderMuted", "─".repeat(ruleWidth))}${theme.fg("dim", COPY_BUTTON)}`;
}

function bottomRule(width: number, theme: CodeFrameTheme): string {
	return theme.fg("borderMuted", "─".repeat(width));
}

function bodyLine(line: string, width: number, layoutIndent: number): string {
	const content = truncateToWidth(stripLayoutWhitespace(line, layoutIndent), width, "…");
	// Keep every code row free of frame glyphs and layout padding. Selection must
	// copy only source text, including meaningful relative indentation in Python.
	return content;
}

/**
 * Replace native Markdown fence rows with a themed code frame while preserving
 * the syntax-highlighted ANSI content produced by Pi for every language.
 */
export function renderCodeFences(
	lines: readonly string[],
	width: number,
	theme: CodeFrameTheme,
	frames: CodeFrame[] = [],
): readonly string[] {
	if (width < 12) return lines;

	const out = [...lines];
	for (let start = 0; start < out.length; start++) {
		const language = fenceLabel(out[start] ?? "");
		if (!language) continue;

		let end = start + 1;
		while (end < out.length && !CLOSING_FENCE_RE.test(plainText(out[end] ?? "").trim())) {
			end++;
		}
		if (end >= out.length) continue;

		const frameWidth = width;
		const body = out.slice(start + 1, end);
		const bodyIndents = body
			.map((line) => plainText(line))
			.filter((line) => line.trim().length > 0)
			.map((line) => leadingSpaces(line));
		const bodyIndent = bodyIndents.length > 0 ? Math.min(...bodyIndents) : 0;
		const framed: string[] = [];

		framed.push(`${oscSequences(out[start] ?? "")}${topRule(frameWidth, language, theme)}`);
		for (let index = start + 1; index < end; index++) {
			framed.push(
				`${oscSequences(out[index] ?? "")}${bodyLine(out[index] ?? "", width, bodyIndent)}`,
			);
		}
		framed.push(`${oscSequences(out[end] ?? "")}${bottomRule(frameWidth, theme)}`);

		out.splice(start, end - start + 1, ...framed);
		frames.push({
			row: start,
			text: body.map((line) => plainText(stripLayoutWhitespace(line, bodyIndent))).join("\n"),
		});
		start += framed.length - 1;
	}
	return out;
}

function patchAssistantRenderer(): void {
	const prototype = AssistantMessageComponent.prototype;
	const cache = new WeakMap<
		object,
		{
			width: number;
			theme: CodeFrameTheme;
			input: readonly string[];
			output: readonly string[];
		}
	>();
	wrapMethod(
		prototype,
		"invalidate",
		(native) =>
			function invalidateCodeFrames(this: object): void {
				cache.delete(this);
				forgetFrames(this);
				native.call(this);
			},
	);
	wrapMethod(
		prototype,
		"render",
		(native) =>
			function renderWithCodeFrames(this: object, width: number): readonly string[] {
				const lines: readonly string[] = native.call(this, width);
				if (!activeTheme) return lines;
				const previous = cache.get(this);
				if (
					previous &&
					previous.width === width &&
					previous.theme === activeTheme &&
					previous.input.length === lines.length &&
					lines.every((line, i) => line === previous.input[i])
				) {
					return previous.output;
				}
				const frames: CodeFrame[] = [];
				const output = renderCodeFences(lines, width, activeTheme, frames);
				rememberFrames(this, frames);
				cache.set(this, { width, theme: activeTheme, input: [...lines], output });
				return output;
			},
	);
}

export default function codeBlocksExtension(pi: ExtensionAPI): void {
	patchAssistantRenderer();
	pi.on("session_start", (_event, ctx) => {
		activeTheme = themeAfterSessionStart(activeTheme, ctx.mode, ctx.ui.theme);
	});
}
