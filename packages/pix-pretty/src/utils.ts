import { relative } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import {
	ANSI_CAPTURE_RE,
	BG_BASE,
	BG_ERROR,
	BOLD,
	BOLD_OFF,
	FG_LNUM,
	FG_RULE,
	hasAnsi,
	RST,
} from "./ansi.js";
import { MAX_PREVIEW_LINES } from "./config.js";
import type {
	FgTheme,
	TextComponentCtor,
	TextComponentLike,
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

export function viewportTextConstructor(TextComponent: TextComponentCtor): TextComponentCtor {
	// SAFETY: a `new`-able ctor and a plain factory returning the same instance
	// shape are interchangeable to callers here; TS can't see the returned
	// ViewportText satisfies TextComponentCtor's construct signature.
	return function ViewportTextComponent(text = "") {
		const component = viewportText(TextComponent);
		component.setText(text);
		return component;
	} as unknown as TextComponentCtor;
}

export function viewportText(
	TextComponent: TextComponentCtor,
): TextComponentLike & ViewportComponent {
	return new ViewportText(new TextComponent("", 0, 0));
}

type ViewportComponent = {
	render(width: number): string[];
	invalidate(): void;
};

type ResultComponent = ViewportComponent & {
	handleInput?(data: string): void;
	wantsKeyRelease?: boolean;
};

type FramableComponent = Partial<ResultComponent> & Partial<TextComponentLike>;
type ResultFrameTheme = {
	fg: (key: "success" | "error", text: string) => string;
};

const RESULT_FRAME = Symbol("pix.resultFrame");
type FramedResultComponent = ResultComponent & {
	[RESULT_FRAME]: {
		component: FramableComponent;
		update(theme: ResultFrameTheme, isError: boolean): void;
	};
};

class ViewportText implements TextComponentLike, ViewportComponent {
	private text = "";
	// Pi re-renders every frame (spinner/streaming). Two-level cache:
	//  1. per-line: `truncateToWidth` result keyed by raw line + width. Streaming
	//     only appends to the tail, so already-fitted lines hit the cache and
	//     only the new/changed lines pay the pi-tui width cost (was O(total
	//     lines) per chunk, now O(new lines)).
	//  2. per-blob: skip re-joining + re-setText'ing the inner component when
	//     neither text nor width changed (idle frames, spinner ticks).
	private fittedWidth = -1;
	private fittedText = "";
	private lineCache = new Map<string, string>();
	private lineCacheWidth = -1;
	// Render-output memo. The inner component's render is a pure function of
	// (fittedText, width), so on an unchanged frame (spinner tick, idle) we skip
	// calling into pi-tui AND skip the fallback split — otherwise both fired
	// every single frame even when nothing changed. The returned array is shared
	// by reference; pi-tui's render contract is read-only (the host joins/prints
	// the lines, never mutates), so we don't defensively copy per frame.
	private rendered: string[] = [];
	private renderedWidth = -1;

	constructor(private readonly component: TextComponentLike) {}

	setText(value: string): void {
		if (value === this.text) return;
		this.text = value;
		this.fittedWidth = -1; // invalidate blob memo (line cache stays valid)
		this.renderedWidth = -1; // invalidate render-output memo
	}

	getText(): string {
		return this.text;
	}

	render(width: number): string[] {
		if (width !== this.fittedWidth) {
			if (width !== this.lineCacheWidth) {
				this.lineCache.clear(); // width changed → every line must re-fit
				this.lineCacheWidth = width;
			}
			const cache = this.lineCache;
			const lines = this.text.split("\n");
			// Bound the cache so a long streaming log can't grow it without limit.
			// The working set is the visible line count; a generous multiple keeps
			// steady-state hits while capping worst-case memory. Reset when exceeded
			// rather than LRU-evicting — simpler, and a width-stable frame refills it.
			if (cache.size > 4 * lines.length + 256) cache.clear();
			this.fittedText = lines
				.map((line) => {
					let fitted = cache.get(line);
					if (fitted === undefined) {
						fitted = truncateToWidth(line, width, "");
						cache.set(line, fitted);
					}
					return fitted;
				})
				.join("\n");
			this.fittedWidth = width;
			this.renderedWidth = -1; // fitted text rebuilt → render output is stale
			this.component.setText(this.fittedText);
		}
		if (width !== this.renderedWidth) {
			this.rendered = this.component.render?.(width) ?? this.fittedText.split("\n");
			this.renderedWidth = width;
		}
		return this.rendered;
	}

	invalidate(): void {
		// invalidate = "output stale for reasons other than (text,width)" — theme /
		// style change. Fitting is pure on (text,width) so fittedText/lineCache stay
		// valid, but the RENDER output (colors) may differ, so drop the render memo;
		// otherwise a same-width frame after invalidate would serve pre-invalidate
		// output forever.
		this.renderedWidth = -1;
		this.component.invalidate?.();
	}
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

/**
 * Status glyphs for collapsed tool rows. `⚠` (warning) is East-Asian *wide*
 * (2 cells) while `✓`/`✗` are 1 cell — render them through `padIcon` so every
 * marker occupies the same fixed column and rows stay vertically aligned.
 * (`⚡` is reserved for strength / model-score badges, not warnings.)
 */
export const COLLAPSED_TOOL_GLYPH: Record<CollapsedToolStatus, string> = {
	success: "✓",
	warning: "⚠",
	error: "✗",
};

/**
 * Normalize a marker glyph to a fixed display width so mixed 1-cell and 2-cell
 * (East-Asian wide / emoji) icons align in a column and the following text
 * always starts at the same offset. Measures actual terminal cells via pi-tui's
 * `visibleWidth` (ANSI-aware), then right-pads with spaces. A glyph already
 * at/over `width` is returned unchanged (never truncated — clipping a marker is
 * worse than a 1-cell overflow).
 *
 * The default width (2) makes every marker occupy exactly two cells, so with a
 * single separator space the following text always starts at the same column:
 *
 *   `${padIcon("✓")} bash`   // "✓  bash"  (1 cell + 1 pad + separator)
 *   `${padIcon("⚠")} bash`   // "⚠ bash"  (2 cells + separator — same column)
 */
export function padIcon(glyph: string, width = 2): string {
	const pad = width - visibleWidth(glyph);
	return pad > 0 ? glyph + " ".repeat(pad) : glyph;
}

/**
 * Join non-empty parts with a middot separator: `dotJoin(["a", "", "b"])` → `"a · b"`.
 * Empty/nullish parts are dropped so callers can pass conditional pieces inline.
 * Pass `paint` (e.g. `(s) => theme.fg("dim", s)`) to tint the separator to theme.
 */
export function dotJoin(
	parts: Array<string | false | null | undefined>,
	paint?: RulePaint,
): string {
	const sep = paint ? paint(" · ") : " · ";
	return parts.filter((p): p is string => Boolean(p)).join(sep);
}

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
	const icon = padIcon(COLLAPSED_TOOL_GLYPH[status]);
	const parts = [
		`${theme.fg(status, icon)} ${theme.fg("toolTitle", theme.bold(tool))}`,
		target ? theme.fg("dim", target) : "",
		meta ? `${theme.fg("muted", "·")} ${theme.fg("muted", meta)}` : "",
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
	/** Header line shown above the body. NON-FRAMED mode only — in framed mode
	 *  the header is intentionally dropped (the collapsed row already carries the
	 *  count, so a floating header above the frame is redundant). */
	header?: string;
	/** Pattern whose matches are highlighted (bold, themed) inside dim lines.
	 *  A string is matched literally (case-insensitive); a RegExp is used as-is
	 *  (callers pass the compiled search pattern so regex greps highlight too). */
	highlight?: string | RegExp;
	/** Wrap the body in a top/bottom rule frame (overflow below), like bash/ls/mcp. */
	frame?: boolean;
	/** Tint the frame rules (green ok, red error) — same status color as bash/ls. */
	paint?: RulePaint;
};

/** Compile a highlight pattern into a global RegExp, or null when it can't
 *  match anything. Strings match literally (case-insensitive); a RegExp is
 *  re-flagged global so every occurrence on a line lights up. */
function toHighlightRegex(pattern: string | RegExp): RegExp | null {
	if (typeof pattern !== "string") {
		const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
		try {
			return new RegExp(pattern.source, flags);
		} catch {
			return null;
		}
	}
	if (!pattern) return null;
	// Literal string → escape regex metacharacters, case-insensitive.
	const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	try {
		return new RegExp(escaped, "gi");
	} catch {
		return null;
	}
}

function dimLineWithHighlight(line: string, theme: FgTheme, pattern?: string | RegExp): string {
	if (!pattern) return theme.fg("dim", line);
	// A line that already carries ANSI (e.g. a source that emitted its own color)
	// can't be safely index-sliced — a match could land inside an escape and
	// corrupt it. Skip highlighting and dim the whole line instead.
	if (hasAnsi(line)) return theme.fg("dim", line);
	const re = pattern ? toHighlightRegex(pattern) : null;
	if (!re) return theme.fg("dim", line);

	// Themed bold hit: theme.fg carries its own reset, so re-open BOLD after it
	// and close with the bold-off code (\x1b[22m) to avoid leaking bold onward.
	const hit = (s: string) => `${BOLD}${theme.fg("success", s)}${BOLD_OFF}`;
	const parts: string[] = [];
	let start = 0;
	for (let m = re.exec(line); m !== null; m = re.exec(line)) {
		const idx = m.index;
		const text = m[0];
		if (text.length === 0) {
			re.lastIndex++; // zero-width match (e.g. /a*/) — advance to avoid a loop
			continue;
		}
		if (idx > start) parts.push(theme.fg("dim", line.slice(start, idx)));
		parts.push(hit(text));
		start = idx + text.length;
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
	const sw = Math.max(8, termW() - 4); // section-rule width inside the 2-space indent
	const body = lines
		.slice(0, maxLines)
		.map(
			(line) => `  ${sectionRule(line, theme, sw) ?? dimLineWithHighlight(line, theme, highlight)}`,
		);
	const header = opts.header ? `  ${theme.fg("dim", opts.header)}` : undefined;
	const overflow =
		lines.length > maxLines
			? `  ${theme.fg("muted", `… ${pluralize(lines.length - maxLines, "more line")}`)}`
			: undefined;

	if (opts.frame) {
		// One shape regardless of line count: a single framed box, no floating
		// header (the collapsed row carries the count). Rules follow status color.
		const out = ruleFrame(body, overflow ? [overflow] : [], undefined, opts.paint);
		return fillToolBackground(out.join("\n"));
	}

	const preview = body;
	if (header) preview.unshift(header);
	if (overflow) preview.push(overflow);
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
	// No upper clamp: frames must fill the true terminal width so our rules align
	// with Pi's native full-width UI on ultrawide displays.
	_cachedTermW = Math.max(1, raw);

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

/** Paints a rule line. Callers pass `(s) => theme.fg(status, s)` so the frame
 *  tint follows the active theme (success/error/warning). Default = neutral FG_RULE. */
export type RulePaint = (glyphs: string) => string;

export function rule(w: number, paint?: RulePaint): string {
	const glyphs = "─".repeat(w);
	return paint ? paint(glyphs) : `${FG_RULE}${glyphs}${RST}`;
}

/** Matches an `=== label ===` separator line (a common shell/echo idiom). */
const SECTION_RE = /^\s*={2,}\s*(.+?)\s*={2,}\s*$/;

/** Fixed dash count before a left-aligned section label. */
const SECTION_RULE_LEAD = 4;

/**
 * If `line` is an `=== label ===` separator, render it as a left-aligned
 * section divider (`──── label ───────────`); otherwise return null. Callers
 * fall back to their normal per-line rendering on null. Fills the full `width`
 * so the divider aligns with the surrounding tool frame. Label and rule both
 * use the muted role — theme-driven, ANSI-safe.
 */
export function sectionRule(line: string, theme: FgTheme, width: number): string | null {
	const m = SECTION_RE.exec(line);
	if (!m || hasAnsi(line)) return null;
	const label = ` ${m[1]} `;
	const trail = width - SECTION_RULE_LEAD - visibleWidth(label);
	// Label fits → lead rule + trailing fill. Too long to fill → don't force a
	// full-width rule; wrap it snugly with 2 dashes each side (`── long text ──`).
	const [lead, tail] = trail >= 2 ? [SECTION_RULE_LEAD, trail] : [2, 2];
	return theme.fg("muted", `${"─".repeat(lead)}${label}${"─".repeat(tail)}`);
}

/** Decorate any tool result component with status-colored top/bottom rules. */
export function frameToolResult<T extends FramableComponent & { setText(value: string): void }>(
	component: T,
	theme: ResultFrameTheme,
	isError: boolean,
): ResultComponent & { setText(value: string): void; getText?: () => string };
export function frameToolResult(
	component: FramableComponent,
	theme: ResultFrameTheme,
	isError: boolean,
): ResultComponent;
export function frameToolResult(
	component: FramableComponent,
	theme: ResultFrameTheme,
	isError: boolean,
): ResultComponent {
	const existing = component as Partial<FramedResultComponent>;
	if (existing[RESULT_FRAME]) {
		existing[RESULT_FRAME].update(theme, isError);
		return component as ResultComponent;
	}
	let frameTheme = theme;
	let failed = isError;
	const framed: FramedResultComponent & Partial<TextComponentLike> = {
		[RESULT_FRAME]: {
			component,
			update(nextTheme, nextError) {
				frameTheme = nextTheme;
				failed = nextError;
			},
		},
		wantsKeyRelease: component.wantsKeyRelease,
		render(width) {
			const paint = (line: string) => frameTheme.fg(failed ? "error" : "success", line);
			return ruleFrame(component.render?.(width) ?? [], [], width, paint);
		},
		invalidate() {
			component.invalidate?.();
		},
		handleInput: component.handleInput ? (data) => component.handleInput?.(data) : undefined,
	};
	if (component.setText) framed.setText = (value) => component.setText?.(value);
	if (component.getText) framed.getText = () => component.getText?.() ?? "";
	return framed;
}

/** Remove the result frame while preserving its underlying renderer component. */
export function unframeToolResult<T extends FramableComponent>(component: T): T {
	const framed = component as Partial<FramedResultComponent>;
	return (framed[RESULT_FRAME]?.component ?? component) as T;
}

/**
 * Frame tool output the way bash/read/sudo do: a top rule, the body lines, a
 * bottom rule, then any footer lines (e.g. `… +N more`) below the close. The
 * single source of the "rule top, rule bottom" invariant so every tool's result
 * block is framed identically — MCP and the shell tools share this.
 */
export function ruleFrame(
	bodyLines: string[],
	footerLines: string[] = [],
	width?: number,
	paint?: RulePaint,
): string[] {
	const r = rule(width ?? termW(), paint);
	return [r, ...bodyLines, r, ...footerLines];
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
