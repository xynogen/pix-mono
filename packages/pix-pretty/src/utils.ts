import { relative } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import {
	ANSI_CAPTURE_RE,
	BG_BASE,
	BG_ERROR,
	BOLD,
	FG_GREEN,
	FG_LNUM,
	FG_RULE,
	RST,
} from "./ansi.js";
import { MAX_PREVIEW_LINES } from "./config.js";
import type {
	FgTheme,
	ToolContent,
	ToolImageContent,
	ToolResultLike,
	ToolTextContent,
} from "./types.js";

export function renderToolError(error: string, theme: FgTheme): string {
	return fillToolBackground(`\n${theme.fg("error", error)}`, BG_ERROR);
}

export function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function preserveToolBackground(ansi: string, bg: string): string {
	return ansi.replace(ANSI_CAPTURE_RE, (seq, params: string) => {
		const codes = params.split(";");
		return params === "0" || codes.includes("49") ? `${seq}${bg}` : seq;
	});
}

export function fillToolBackground(text: string, bg = BG_BASE, width?: number): string {
	const resolvedWidth = width ?? termW();
	return text
		.split("\n")
		.map((line) => {
			const normalized = preserveToolBackground(line, bg);
			const fitted = preserveToolBackground(truncateToWidth(normalized, resolvedWidth, ""), bg);
			const padding = Math.max(0, resolvedWidth - visibleWidth(fitted));
			return `${bg}${fitted}${" ".repeat(padding)}${RST}`;
		})
		.join("\n");
}

export function pluralize(count: number, noun: string, plural?: string): string {
	return `${count} ${count === 1 ? noun : (plural ?? `${noun}s`)}`;
}

export interface FormatJsonOptions {
	/** Hard char ceiling for the whole block; a longer block is clipped with an ellipsis. */
	maxChars?: number;
	/** Line ceiling; excess lines are dropped for a `… +N more` footer. Default MAX_PREVIEW_LINES. */
	maxLines?: number;
	/**
	 * Fallback per-line hard-wrap for NON-JSON input only. When the value parses
	 * as JSON, reindenting already breaks any mega-line into short lines AND the
	 * result stays valid JSON, so callers can still syntax-highlight it — wrapping
	 * it would split string values mid-token and defeat highlighting. This only
	 * bites a genuine non-JSON one-liner (a multi-KB plain string) the TUI can't
	 * wrap on its own. 0 disables.
	 */
	wrapWidth?: number;
}

// Hard-wrap a single line into `width`-char chunks. Preserves all characters
// (this is wrapping, not truncation) so the data stays complete.
function hardWrapLine(line: string, width: number): string[] {
	if (width <= 0 || line.length <= width) return [line];
	const out: string[] = [];
	for (let i = 0; i < line.length; i += width) out.push(line.slice(i, i + width));
	return out;
}

/**
 * Pretty-print a JSON-ish value for terminal display and bound its cost.
 *
 * Splitting an object into short lines is itself a win: the TUI measures/wraps
 * per line, so one huge line is the pathological case; a re-serialized object
 * is many cheap lines even when it has more total chars.
 *
 * Bounds applied in order: parse+reindent → (non-JSON only) hard-wrap long
 * lines → line cap (`… +N more`) → char cap. This shapes only the DISPLAY
 * string; callers keep the untruncated payload for the model. The formatted
 * JSON stays valid so callers can syntax-highlight it. Pure and host-agnostic.
 */
export function formatJson(value: unknown, options: FormatJsonOptions = {}): string {
	const { maxChars, maxLines = MAX_PREVIEW_LINES, wrapWidth = 0 } = options;

	let text: string;
	let isJson = true;
	try {
		const parsed = typeof value === "string" ? JSON.parse(value) : value;
		text = JSON.stringify(parsed, null, 2);
	} catch {
		// Not JSON (or a circular object) — fall back to a plain string, still bounded.
		text = typeof value === "string" ? value : String(value);
		isJson = false;
	}

	let lines = text.split("\n");
	// Only hard-wrap non-JSON: wrapping reindented JSON would split string values
	// mid-token and invalidate the block for downstream highlighting. JSON is
	// already short-lined after reindent, so it never needs this guard.
	if (wrapWidth > 0 && !isJson) lines = lines.flatMap((line) => hardWrapLine(line, wrapWidth));

	if (lines.length > maxLines) {
		const hidden = lines.length - maxLines;
		lines = [...lines.slice(0, maxLines), `… +${hidden} more`];
	}

	let out = lines.join("\n");
	if (maxChars !== undefined && out.length > maxChars) {
		// Char cap is a last-resort guard (e.g. many wrapped lines under the line
		// cap still exceeding the budget).
		out = `${out.slice(0, Math.max(0, maxChars - 1))}…`;
	}
	return out;
}

export type CollapsedToolStatus = "success" | "error" | "warning";

type CollapsedToolTheme = {
	fg: (
		key: "success" | "error" | "warning" | "toolTitle" | "muted" | "dim",
		text: string,
	) => string;
	bold: (text: string) => string;
};

/** Format the shared one-row content without assuming a render shell. */
export function formatCollapsedToolRow(
	theme: CollapsedToolTheme,
	tool: string,
	target: string,
	meta = "",
	status: CollapsedToolStatus = "success",
): string {
	const icon = status === "success" ? "✓" : status === "warning" ? "⚡" : "✗";
	const parts = [
		`${theme.fg(status, icon)} ${theme.fg("toolTitle", theme.bold(tool))}`,
		target ? theme.fg("muted", target) : "",
		meta ? `${theme.fg("dim", "·")} ${theme.fg("dim", meta)}` : "",
	].filter(Boolean);
	return parts.join(" ");
}

/** Render shared one-row content for tools using the self-rendered shell. */
export function renderCollapsedToolRow(
	theme: CollapsedToolTheme,
	tool: string,
	target: string,
	meta = "",
	status: CollapsedToolStatus = "success",
): string {
	return fillToolBackground(formatCollapsedToolRow(theme, tool, target, meta, status));
}

/** Hide renderCall after its paired result has auto-collapsed. */
export function hideCollapsedToolCall(
	state: { collapsed?: boolean },
	expanded: boolean,
	setText: (text: string) => void,
): boolean {
	if (!state.collapsed || expanded) return false;
	setText("");
	return true;
}

export type DimPreviewOptions = {
	maxLines?: number;
	header?: string;
	/** Pattern whose matches are highlighted (green bold) inside dim lines. */
	highlight?: string;
};

function dimLineWithHighlight(line: string, theme: FgTheme, pattern?: string): string {
	if (!pattern) return theme.fg("dim", line);
	const foldedLine = line.toLocaleLowerCase();
	const foldedPattern = pattern.toLocaleLowerCase();
	if (!foldedPattern) return theme.fg("dim", line);

	const parts: string[] = [];
	let start = 0;
	for (;;) {
		const match = foldedLine.indexOf(foldedPattern, start);
		if (match < 0) break;
		if (match > start) parts.push(theme.fg("dim", line.slice(start, match)));
		parts.push(`${FG_GREEN}${BOLD}${line.slice(match, match + pattern.length)}${RST}`);
		start = match + pattern.length;
	}
	if (start < line.length) parts.push(theme.fg("dim", line.slice(start)));
	return parts.length > 0 ? parts.join("") : theme.fg("dim", line);
}

export function renderDimPreview(
	text: string,
	theme: FgTheme,
	opts: DimPreviewOptions = {},
): string {
	const maxLines = opts.maxLines ?? MAX_PREVIEW_LINES;
	const highlight = opts.highlight;
	const output = normalizeLineEndings(text).trim() || "done";
	const lines = output.split("\n");
	const preview = lines
		.slice(0, maxLines)
		.map((line) => `  ${dimLineWithHighlight(line, theme, highlight)}`);
	if (opts.header) preview.unshift(`  ${theme.fg("dim", opts.header)}`);
	if (lines.length > maxLines) {
		const more = pluralize(lines.length - maxLines, "more line");
		preview.push(`  ${theme.fg("dim", `… ${more}`)}`);
	}
	return fillToolBackground(preview.join("\n"));
}

let _cachedTermW: number | undefined;
let _termWResizeBound = false;

function _bindTermWResize(): void {
	if (_termWResizeBound) return;
	_termWResizeBound = true;
	// Persistent listeners: every SIGWINCH invalidates the cache so the next
	// termW() re-reads. `.once` only caught the first resize, leaving width
	// stale on subsequent resizes.
	const invalidate = () => {
		_cachedTermW = undefined;
	};
	process.stdout.on("resize", invalidate);
	process.stdin.on("resize", invalidate);
}

/** Read terminal width — checks all available sources in priority order.
 *  Falls back to querying the controlling tty via fd 1/2/stdin ioctl.
 *  Result is cached and invalidated on SIGWINCH / stdout resize. */
export function termW(): number {
	_bindTermWResize();
	if (_cachedTermW !== undefined) return _cachedTermW;

	const stderrWithColumns = process.stderr as NodeJS.WriteStream & {
		columns?: number;
	};
	const raw =
		process.stdout.columns ||
		stderrWithColumns.columns ||
		Number.parseInt(process.env.COLUMNS ?? "", 10) ||
		_readTtyColumns() ||
		120;
	_cachedTermW = Math.max(1, Math.min(raw, 210));

	return _cachedTermW;
}

/** Synchronously query the tty size via Node's built-in ioctl binding.
 *  Works even when stdout/stderr are piped, as long as stdin is a tty. */
function _readTtyColumns(): number | undefined {
	try {
		// Node exposes getWindowSize() on tty.ReadStream / tty.WriteStream
		const { getWindowSize } = require("node:tty") as {
			getWindowSize?: (fd: number) => [number, number];
		};
		if (getWindowSize) {
			// Try fd 1 (stdout), 2 (stderr), 0 (stdin) in order
			for (const fd of [1, 2, 0]) {
				try {
					const [cols] = getWindowSize(fd);
					if (cols && cols > 0) return cols;
				} catch {
					/* fd not a tty */
				}
			}
		}
	} catch {
		/* tty module unavailable */
	}
	return undefined;
}

export function shortPath(cwd: string, home: string, p: string): string {
	if (!p) return "";
	const r = relative(cwd, p);
	if (!r.startsWith("..") && !r.startsWith("/")) return r;
	return p.replace(home, "~");
}

export function rule(w: number): string {
	return `${FG_RULE}${"─".repeat(w)}${RST}`;
}

export function lnum(n: number, w: number): string {
	const v = String(n);
	return `${FG_LNUM}${" ".repeat(Math.max(0, w - v.length))}${v}${RST}`;
}

// ---------------------------------------------------------------------------
// Human-readable file size
// ---------------------------------------------------------------------------

export function humanSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

// ---------------------------------------------------------------------------
// File-type icons — Nerd Font glyphs (Seti-UI + Devicons, stable in NF v3+)
//
// Requires a Nerd Font installed (e.g., JetBrainsMono Nerd Font, FiraCode NF).
// Fallback: set PRETTY_ICONS=none to disable icons.
// ---------------------------------------------------------------------------

export function isTextContent(content: ToolContent): content is ToolTextContent {
	return content.type === "text";
}

export function isImageContent(content: ToolContent): content is ToolImageContent {
	return content.type === "image";
}

export function getTextContent(result: ToolResultLike): string {
	return (
		result.content
			?.filter(isTextContent)
			.map((content) => content.text || "")
			.join("\n") ?? ""
	);
}

/** Add renderer metadata without discarding execution metadata from the upstream tool. */
export function setResultDetails<T>(result: ToolResultLike, details: T): void {
	const upstream =
		result.details && typeof result.details === "object"
			? (result.details as Record<string, unknown>)
			: undefined;
	result.details = upstream ? { ...upstream, ...details } : details;
}

export function makeTextResult<TDetails>(
	text: string,
	details: TDetails,
): ToolResultLike<TDetails> {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

export function appendNotices(text: string, notices: string[]): string {
	return notices.length ? `${text}\n\n[${notices.join(". ")}]` : text;
}

export function countRipgrepMatches(text: string): number {
	return text
		.trim()
		.split("\n")
		.filter((line) => /^.+?[:-]\d+[:-]/.test(line)).length;
}

export function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function trimToUndefined(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}
