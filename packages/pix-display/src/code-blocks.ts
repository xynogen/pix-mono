import {
	AssistantMessageComponent,
	type Theme,
	truncateToWidth,
	visibleWidth,
} from "@xynogen/pix-pretty/tui";
import type { ExtensionAPI } from "@xynogen/pix-runtime/host";

const OPENING_FENCE_RE = /^```([^`]*)$/;
const CLOSING_FENCE_RE = /^```\s*$/;
const DEFAULT_LABEL = "code";
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const BACKGROUND_ANSI_RE = /\x1b\[(?:4[0-9]|48)(?:;[^m]*)?m/g;
const OSC_RE = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const PATCHED = Symbol.for("@xynogen/pix-display:code-block-renderer");

type CodeFrameTheme = Pick<Theme, "bold" | "fg">;
type RenderMode = "tui" | "rpc" | "json" | "print";

type PatchablePrototype = {
	[PATCHED]?: boolean;
	render(width: number): string[];
	invalidate(): void;
};

let activeTheme: CodeFrameTheme | undefined;

/**
 * Preserve the main TUI theme when an in-process non-TUI child session starts.
 * Subagents share this module and the patched prototype with the parent; letting
 * their print/RPC session clear the theme silently disables code frames in the
 * still-running parent transcript.
 */
export function themeAfterSessionStart(
	current: CodeFrameTheme | undefined,
	mode: RenderMode,
	theme: CodeFrameTheme,
): CodeFrameTheme | undefined {
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
	const available = Math.max(1, width - 4);
	const displayLanguage = truncateToWidth(language, available, "…");
	const label = theme.bold(theme.fg("accent", ` ${displayLanguage} `));
	const ruleWidth = Math.max(0, width - visibleWidth(label) - 2);
	return `${theme.fg("borderMuted", "──")}${label}${theme.fg("borderMuted", "─".repeat(ruleWidth))}`;
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
export function renderCodeFences(lines: string[], width: number, theme: CodeFrameTheme): string[] {
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
		start += framed.length - 1;
	}
	return out;
}

function patchAssistantRenderer(): void {
	const prototype = AssistantMessageComponent.prototype as PatchablePrototype;
	if (prototype[PATCHED]) return;

	const nativeRender = prototype.render;
	const nativeInvalidate = prototype.invalidate;
	const cache = new WeakMap<
		PatchablePrototype,
		{
			width: number;
			theme: CodeFrameTheme;
			input: string[];
			output: string[];
		}
	>();
	prototype.invalidate = function invalidateCodeFrames(): void {
		cache.delete(this);
		nativeInvalidate.call(this);
	};
	prototype.render = function renderWithCodeFrames(width: number): string[] {
		const lines = nativeRender.call(this, width);
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
		const output = renderCodeFences(lines, width, activeTheme);
		cache.set(this, { width, theme: activeTheme, input: [...lines], output });
		return output;
	};
	prototype[PATCHED] = true;
}

export default function codeBlocksExtension(pi: ExtensionAPI): void {
	patchAssistantRenderer();
	pi.on("session_start", (_event, ctx) => {
		activeTheme = themeAfterSessionStart(activeTheme, ctx.mode, ctx.ui.theme);
	});
}
