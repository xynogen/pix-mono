/**
 * pix-pretty/modal-frame — shared primitives for interactive overlay UIs.
 *
 * Provides:
 *   frameLines()       — render a rounded bordered modal box (╭─╮╰─╯)
 *   modalWidth()       — clamp terminal width to a sane modal width
 *   selectListTheme()  — canonical SelectList theme config (accent + muted + dim)
 *
 * Used by: gate-overlay, confirm, and (via re-export) pix-ask.
 */

import {
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { config } from "@xynogen/pix-runtime/config";
import { prettySection, type RenderSize } from "@xynogen/pix-runtime/sections";

export { truncateToWidth, visibleWidth, wrapTextWithAnsi };

// ponytail: re-export ANSI-safe wrapping via pix-pretty so consumers dedupe local wrapText (pix-mcp)

// ── Constants ─────────────────────────────────────────────────────────────────

const MIN_WIDTH = 40;
/** 2 border cols + 2 padding spaces */
const CHROME = 4;

// ── Width ─────────────────────────────────────────────────────────────────────

function resolveRenderSize(limit: RenderSize, available: number): number {
	if (typeof limit === "number") return Math.floor(limit);
	return Math.floor((available * Number.parseFloat(limit)) / 100);
}

/** Resolve modal width without exceeding available render width. */
export function modalWidth(termWidth: number, limit: RenderSize = "100%"): number {
	const available = Number.isFinite(termWidth) ? Math.max(1, Math.floor(termWidth)) : MIN_WIDTH;
	return Math.max(1, Math.min(available, resolveRenderSize(limit, available)));
}

/** Native overlay options matching shared modal size contract. */
export function modalOverlayOptions(): {
	anchor: "center";
	width: RenderSize;
	maxHeight: RenderSize;
	margin: 2;
} {
	const pretty = config(prettySection);
	return {
		anchor: "center",
		width: pretty.maxRenderWidth,
		maxHeight: pretty.maxRenderHeight,
		margin: 2,
	};
}

// ── Frame ─────────────────────────────────────────────────────────────────────

export interface FrameOptions {
	width: number;
	lines: string[];
	/** Color function for border glyphs — e.g. `(s) => theme.fg("accent", s)` */
	color: (s: string) => string;
	/** Background fill function — e.g. `(s) => theme.bg("customMessageBg", s)` */
	bg?: (s: string) => string;
	/**
	 * Base foreground for content rows — e.g. `(s) => theme.fg("text", s)`.
	 * Establishes a readable default color so raw (unstyled) text — such as the
	 * unselected labels a pi-tui SelectList emits without any fg escape — does
	 * not fall back to the terminal default and collide with the modal `bg`.
	 * Content that carries its own fg escapes is unaffected.
	 */
	fg?: (s: string) => string;
	/** Optional pre-styled string rendered as the first content row (tab bar etc.) */
	top?: string;
	/**
	 * Wrap over-wide content instead of cutting its tail. Default true.
	 *
	 * Truncation is never safe for text a user acts on: a clipped command reads
	 * as a complete one, and the default `truncateToWidth` ellipsis (`...`) is
	 * indistinguishable from literal text. Wrapping is lossless for every shape
	 * we render — spaced prose, 300-char unbroken tokens, base64, long paths and
	 * ANSI-styled spans all wrap without producing an over-wide row.
	 *
	 * Set false only for rows that are already width-fitted by the caller and
	 * must stay exactly one row (fixed-column tables).
	 */
	wrap?: boolean;
}

// ── Line fitting ──────────────────────────────────────────────────────────────

/** Ellipsis for the wrap=false path — visibly a marker, unlike a bare "...". */
const ELLIPSIS = "…";

export interface FitResult {
	rows: string[];
	/**
	 * True when a row lost characters that are recoverable nowhere in the frame.
	 * Wrapping never sets this — only the truncating paths do.
	 *
	 * Vertical overflow is deliberately NOT reported here: paged-out body rows
	 * stay reachable via PageUp/PageDown and are described by ViewportState.
	 * Horizontal truncation is unrecoverable, so it needs its own signal.
	 */
	truncated: boolean;
}

/**
 * Expand one logical line into the rendered rows it occupies at `inner` width.
 * Blank lines stay a single blank row so callers keep their spacing.
 */
export function fitModalLine(line: string, inner: number, wrap = true): FitResult {
	const width = Number.isFinite(inner) ? Math.max(1, Math.floor(inner)) : 1;
	if (line === "") return { rows: [""], truncated: false };
	if (visibleWidth(line) <= width) return { rows: [line], truncated: false };
	if (!wrap) return { rows: [truncateToWidth(line, width, ELLIPSIS)], truncated: true };
	const wrapped = wrapTextWithAnsi(line, width);
	// Defensive: if wrapping cannot produce rows we fall back to a cut, and that
	// IS lossy — report it instead of pretending the row survived intact.
	if (wrapped.length === 0) {
		return { rows: [truncateToWidth(line, width, ELLIPSIS)], truncated: true };
	}
	return { rows: wrapped, truncated: false };
}

/** Expand a list of logical lines into rendered rows. */
export function fitModalLines(lines: string[], inner: number, wrap = true): FitResult {
	const rows: string[] = [];
	let truncated = false;
	for (const line of lines) {
		const fit = fitModalLine(line, inner, wrap);
		rows.push(...fit.rows);
		truncated = truncated || fit.truncated;
	}
	return { rows, truncated };
}

/**
 * Render a rounded modal box.
 *
 * Returns an array of full-width ANSI strings:
 *   ╭──────────────────╮
 *   │ [top row]        │   ← only if top is set
 *   │ content line 1   │
 *   │ content line 2   │
 *   ╰──────────────────╯
 *
 * Solid background fill — theme fg/bold spans that emit \x1b[0m are patched
 * so the background colour is re-asserted, preventing transparent holes.
 */
export function frameLines(opts: FrameOptions): string[] {
	const { color, top } = opts;
	const width = Number.isFinite(opts.width) ? Math.max(1, Math.floor(opts.width)) : 1;
	if (width < CHROME) {
		const first = top ?? opts.lines[0] ?? "";
		return [truncateToWidth(first, width)];
	}
	const bg = opts.bg ?? ((s: string) => s);
	const fg = opts.fg;
	const inner = width - CHROME;
	const dashes = "─".repeat(width - 2);
	const wrap = opts.wrap ?? true;
	// Expand before framing so a long command wraps instead of losing its tail.
	const { rows: lines } = fitModalLines(opts.lines, inner, wrap);

	// Derive the OPEN sequences so we can re-assert them after any embedded
	// reset. A full reset (\x1b[0m) clears both fg and bg; \x1b[49m clears bg;
	// \x1b[39m clears fg. Re-emitting the base opens after each keeps the modal
	// background solid AND gives raw text a readable foreground.
	const SENTINEL = "\x00";
	const bgOpen = bg(SENTINEL).split(SENTINEL)[0] ?? "";
	const fgOpen = fg ? (fg(SENTINEL).split(SENTINEL)[0] ?? "") : "";
	const reassert = (s: string): string =>
		bgOpen || fgOpen
			? s.replace(/\x1b\[([0-9;]*)m/g, (seq, p: string) => {
					const parts = p.split(";");
					const isFull = p === "0";
					let tail = seq;
					if (isFull || parts.includes("49")) tail += bgOpen;
					if (isFull || parts.includes("39")) tail += fgOpen;
					return tail;
				})
			: s;

	const row = (content: string): string => {
		const pad = inner - visibleWidth(content);
		const padded = pad > 0 ? content + " ".repeat(pad) : truncateToWidth(content, inner, ELLIPSIS);
		// Wrap in the base fg first so unstyled text gets an explicit color, then
		// reassert base opens after any embedded resets from theme fg/bold spans.
		const body = fgOpen ? reassert(fg?.(padded) ?? padded) : reassert(padded);
		return bg(`${color("│")} ${body} ${color("│")}`);
	};

	const out: string[] = [bg(color(`╭${dashes}╮`))];
	if (top !== undefined) out.push(row(top));
	for (const line of lines) out.push(row(line));
	out.push(bg(color(`╰${dashes}╯`)));
	return out;
}

// ── Height ────────────────────────────────────────────────────────────────────

/** Fail-closed floor for ordinary overlays. Compare against modalHeight(), not raw rows. */
export const MIN_MODAL_HEIGHT = 6;
/** Fail-closed floor for permission overlays. Compare against modalHeight(), not raw rows. */
export const MIN_PERMISSION_MODAL_HEIGHT = 12;

/** Rows a modal may occupy before paging, never more than terminal has. */
export function modalHeight(
	terminalRows: number,
	limit: RenderSize = config(prettySection).maxRenderHeight,
): number {
	const rows = Number.isFinite(terminalRows) ? Math.max(1, Math.floor(terminalRows)) : 24;
	return Math.max(1, Math.min(rows, resolveRenderSize(limit, rows)));
}

/** Current modal budget. Pass host TUI rows when available; stdout is fallback. */
export function terminalModalHeight(
	terminalRows = process.stdout.rows ?? 24,
	limit: RenderSize = config(prettySection).maxRenderHeight,
): number {
	return modalHeight(terminalRows, limit);
}

/** Rows available for variable body content: total − borders − pinned rows. */
export function modalBodyCapacity(maxHeight: number, pinnedRows: number): number {
	const height = Number.isFinite(maxHeight) ? Math.max(0, Math.floor(maxHeight)) : 0;
	const pinned = Number.isFinite(pinnedRows) ? Math.max(0, Math.floor(pinnedRows)) : 0;
	return Math.max(0, height - 2 - pinned);
}

/**
 * Adjust a body offset so a selected rendered-row range remains visible.
 * `selectedEnd` is exclusive, matching Array#slice and viewport state.
 */
export function ensureVisibleOffset(
	bodyOffset: number,
	viewportRows: number,
	totalRows: number,
	selectedStart: number,
	selectedEnd: number,
): number {
	const viewport = Number.isFinite(viewportRows) ? Math.max(0, Math.floor(viewportRows)) : 0;
	const total = Number.isFinite(totalRows) ? Math.max(0, Math.floor(totalRows)) : 0;
	if (viewport === 0 || total === 0) return 0;

	const maxOffset = Math.max(0, total - viewport);
	let offset = Number.isFinite(bodyOffset)
		? Math.min(maxOffset, Math.max(0, Math.floor(bodyOffset)))
		: 0;
	const start = Number.isFinite(selectedStart)
		? Math.min(total, Math.max(0, Math.floor(selectedStart)))
		: 0;
	const end = Number.isFinite(selectedEnd)
		? Math.min(total, Math.max(start, Math.floor(selectedEnd)))
		: start;

	if (start < offset) offset = start;
	else if (end > offset + viewport) offset = end - viewport;
	return Math.min(maxOffset, Math.max(0, offset));
}

/** Move a modal body by one viewport while clamping to its valid range. */
/** Move a modal body by half a viewport (like Ctrl+D / Ctrl+U in vim). */
export function pageBodyOffset(
	bodyOffset: number,
	visibleBodyLines: number,
	maxBodyOffset: number,
	direction: -1 | 1,
): number {
	const current = Number.isFinite(bodyOffset) ? Math.max(0, Math.floor(bodyOffset)) : 0;
	const size = Number.isFinite(visibleBodyLines) ? Math.max(1, Math.floor(visibleBodyLines)) : 1;
	const max = Number.isFinite(maxBodyOffset) ? Math.max(0, Math.floor(maxBodyOffset)) : 0;
	const step = Math.max(1, Math.floor(size / 2));
	return Math.min(max, Math.max(0, current + direction * step));
}

/** Mutable paging state shared by modal consumers. */
export interface ModalPageKeybindings {
	matches(data: string, action: "tui.select.pageUp" | "tui.select.pageDown"): boolean;
}

export class ModalPager {
	bodyOffset = 0;
	visibleBodyLines = 1;
	maxBodyOffset = 0;
	private inspecting = false;

	sync(result: ModalFrameResult): void {
		this.bodyOffset = result.bodyOffset;
		this.visibleBodyLines = Math.max(1, result.visibleBodyLines);
		this.maxBodyOffset = result.maxBodyOffset;
	}

	page(direction: -1 | 1): boolean {
		const next = pageBodyOffset(
			this.bodyOffset,
			this.visibleBodyLines,
			this.maxBodyOffset,
			direction,
		);
		if (next === this.bodyOffset) return false;
		this.bodyOffset = next;
		this.inspecting = true;
		return true;
	}

	/** Resume auto-scroll to the selected row after arrows/filtering. */
	followSelection(): void {
		this.inspecting = false;
	}

	selectedLine(line: number): number | undefined {
		return this.inspecting ? undefined : line;
	}

	selectedRange(range: { start: number; end: number }): { start: number; end: number } | undefined {
		return this.inspecting ? undefined : range;
	}

	reset(): void {
		this.bodyOffset = 0;
		this.visibleBodyLines = 1;
		this.maxBodyOffset = 0;
		this.inspecting = false;
	}

	/**
	 * Handle paging input. Set `arrowPages` to also accept ←/→ as page up/down
	 * (only safe when the overlay doesn't use left/right for other navigation).
	 */
	handleInput(data: string, keybindings?: ModalPageKeybindings, arrowPages?: boolean): boolean {
		if (
			keybindings?.matches(data, "tui.select.pageUp") ||
			matchesKey(data, Key.pageUp) ||
			(arrowPages && matchesKey(data, Key.left))
		) {
			return this.page(-1);
		}
		if (
			keybindings?.matches(data, "tui.select.pageDown") ||
			matchesKey(data, Key.pageDown) ||
			(arrowPages && matchesKey(data, Key.right))
		) {
			return this.page(1);
		}
		return false;
	}
}

// ── Sectioned frame ───────────────────────────────────────────────────────────

export interface ViewportState {
	start: number;
	end: number;
	total: number;
	hiddenBefore: number;
	hiddenAfter: number;
	/** Current page number (1-based). */
	page: number;
	/** Total number of pages. */
	totalPages: number;
}

export interface ModalFrameOptions extends Omit<FrameOptions, "lines"> {
	/** Hard cap on returned rows, borders included. */
	maxHeight: number;
	/** Fail closed below this total height. */
	minHeight?: number;
	/** Pinned rows above the body (title etc.). */
	header?: string[];
	/** Variable rows — the only region that pages. */
	body: string[];
	/** Pinned rows below the body (controls, help). */
	footer?: string[];
	bodyOffset?: number;
	/** Logical body-line index that must remain visible after wrapping. */
	selectedBodyLine?: number;
	/** Rendered body-row range that must remain visible (end is exclusive). */
	selectedBodyRange?: { start: number; end: number };
	/** Styled by the caller; shown directly above the body when rows are hidden. */
	overflowLine?: (state: ViewportState) => string;
}

export interface ModalFrameResult {
	lines: string[];
	bodyOffset: number;
	maxBodyOffset: number;
	visibleBodyLines: number;
	/** True when body rows are hidden but remain reachable through paging. */
	bodyOverflowed: boolean;
	/** True only when characters were irreversibly removed from rendered text. */
	textTruncated: boolean;
	/** False when pinned rows plus one body row cannot fit — callers must fail closed. */
	pinnedRowsFit: boolean;
}

const defaultOverflowLine = ({ page, totalPages }: ViewportState) =>
	`PageUp/PageDown inspect • ${page}/${totalPages}`;

/**
 * Render a modal whose pinned header/footer rows always survive and whose body
 * is paged. Never returns more than `maxHeight` rows, and delegates all styling
 * to frameLines() so ANSI/fg/bg handling has exactly one implementation.
 */
export function frameModal(opts: ModalFrameOptions): ModalFrameResult {
	const { width, maxHeight, color, bg, fg, top } = opts;
	const overflowLine = opts.overflowLine ?? defaultOverflowLine;
	const wrap = opts.wrap ?? true;

	// Page over RENDERED rows, not logical lines. With wrapping enabled a single
	// long command becomes several rows, so budgets computed from logical length
	// would under-count and let the frame exceed maxHeight.
	const inner = Math.max(1, width - CHROME);
	const headerFit = fitModalLines(opts.header ?? [], inner, wrap);
	const footerFit = fitModalLines(opts.footer ?? [], inner, wrap);
	const bodyFit = fitModalLines(opts.body, inner, wrap);
	let selectedBodyRange = opts.selectedBodyRange;
	if (Number.isFinite(opts.selectedBodyLine)) {
		const index = Math.min(
			Math.max(0, Math.floor(opts.selectedBodyLine ?? 0)),
			Math.max(0, opts.body.length - 1),
		);
		const start = fitModalLines(opts.body.slice(0, index), inner, wrap).rows.length;
		const length = fitModalLine(opts.body[index] ?? "", inner, wrap).rows.length;
		selectedBodyRange = { start, end: start + Math.max(1, length) };
	}
	const header = headerFit.rows;
	const footer = footerFit.rows;
	const body = bodyFit.rows;
	// `top` is a deliberately fixed single row (tabs etc.), so an over-wide top
	// row is the only default-wrap path that may still lose characters.
	const topTruncated = top !== undefined && visibleWidth(top) > inner;
	const textTruncated =
		topTruncated || headerFit.truncated || footerFit.truncated || bodyFit.truncated;

	const cap = Number.isFinite(maxHeight) ? Math.max(1, Math.floor(maxHeight)) : 1;
	const minHeight = Number.isFinite(opts.minHeight)
		? Math.max(1, Math.floor(opts.minHeight ?? 1))
		: 1;
	const diagnostic = "Terminal too short — resize or press esc to cancel";
	if (cap < Math.max(3, minHeight)) {
		return {
			lines: [truncateToWidth(diagnostic, Math.max(1, width))].slice(0, cap),
			bodyOffset: 0,
			maxBodyOffset: 0,
			visibleBodyLines: 0,
			bodyOverflowed: body.length > 0,
			textTruncated: true,
			pinnedRowsFit: false,
		};
	}

	const chrome = 2 + (top !== undefined ? 1 : 0);
	const contentBudget = cap - chrome;
	const pinned = header.length + footer.length;
	const needed = pinned + (body.length > 0 ? 1 : 0);
	const bodyBudget = contentBudget - pinned;
	const overflows = body.length > Math.max(0, bodyBudget);
	const canShowOverflow = !overflows || bodyBudget >= 2;

	// Fail closed: hidden content needs both an indicator and one inspectable row.
	// Compact the line list *before* framing so borders are never sliced off.
	if (contentBudget < needed || !canShowOverflow) {
		// Wrap first, THEN slice. Slicing logical lines and letting frameLines wrap
		// afterwards re-expands the list and pushes the closing border past `cap`.
		const diag = fitModalLines(
			[...(header.length > 0 ? [header[0] as string] : []), diagnostic],
			inner,
			wrap,
		).rows.slice(0, Math.max(1, cap - 2));
		return {
			lines: frameLines({ width, lines: diag, color, bg, fg, wrap: false }),
			bodyOffset: 0,
			maxBodyOffset: 0,
			visibleBodyLines: 0,
			bodyOverflowed: body.length > 0,
			textTruncated,
			pinnedRowsFit: false,
		};
	}

	const visibleBodyLines = overflows ? bodyBudget - 1 : bodyBudget;
	const maxBodyOffset = Math.max(0, body.length - visibleBodyLines);
	let offset = Math.min(Math.max(0, Math.floor(opts.bodyOffset ?? 0)), maxBodyOffset);
	if (selectedBodyRange) {
		offset = ensureVisibleOffset(
			offset,
			visibleBodyLines,
			body.length,
			selectedBodyRange.start,
			selectedBodyRange.end,
		);
	}

	const end = Math.min(body.length, offset + visibleBodyLines);
	const lines = [...header];
	if (overflows) {
		const step = Math.max(1, Math.floor(visibleBodyLines / 2));
		const totalPages = Math.max(1, Math.ceil(maxBodyOffset / step) + 1);
		const page = offset >= maxBodyOffset ? totalPages : Math.floor(offset / step) + 1;
		lines.push(
			overflowLine({
				start: offset,
				end,
				total: body.length,
				hiddenBefore: offset,
				hiddenAfter: body.length - end,
				page,
				totalPages,
			}),
		);
	}
	lines.push(...body.slice(offset, end), ...footer);

	return {
		// Already fitted above — pass wrap:false so rows are not re-expanded.
		lines: frameLines({ width, lines, color, bg, fg, top, wrap: false }),
		bodyOffset: offset,
		maxBodyOffset,
		visibleBodyLines,
		bodyOverflowed: overflows,
		textTruncated,
		pinnedRowsFit: true,
	};
}

// ── SelectList theme ──────────────────────────────────────────────────────────

export interface SelectListThemeConfig {
	selectedPrefix: (t: string) => string;
	selectedText: (t: string) => string;
	description: (t: string) => string;
	scrollInfo: (t: string) => string;
	noMatch: (t: string) => string;
}

interface FgTheme {
	fg(color: string, text: string): string;
}

/**
 * Canonical SelectList theme for interactive overlays.
 * accent = active/selected, muted = descriptions, dim = scroll/hints, warning = no-match.
 */
export function selectListTheme(theme: FgTheme, accent = "accent"): SelectListThemeConfig {
	return {
		selectedPrefix: (t) => theme.fg(accent, t),
		selectedText: (t) => theme.fg(accent, t),
		description: (t) => theme.fg("muted", t),
		scrollInfo: (t) => theme.fg("dim", t),
		noMatch: (t) => theme.fg("warning", t),
	};
}
