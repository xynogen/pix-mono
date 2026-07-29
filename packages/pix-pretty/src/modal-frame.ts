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

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ── Constants ─────────────────────────────────────────────────────────────────

const MIN_WIDTH = 40;
const MAX_WIDTH = 96;
const MARGIN = 4;
/** 2 border cols + 2 padding spaces */
const CHROME = 4;

// ── Width ─────────────────────────────────────────────────────────────────────

/** Prefer a 40–96 column modal without exceeding the available render width. */
export function modalWidth(termWidth: number): number {
	const available = Number.isFinite(termWidth) ? Math.max(1, Math.floor(termWidth)) : MIN_WIDTH;
	const preferred = Math.max(MIN_WIDTH, available - MARGIN);
	return Math.min(MAX_WIDTH, available, preferred);
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
	const { lines, color, top } = opts;
	const width = Number.isFinite(opts.width) ? Math.max(1, Math.floor(opts.width)) : 1;
	if (width < CHROME) {
		const first = top ?? lines[0] ?? "";
		return [truncateToWidth(first, width)];
	}
	const bg = opts.bg ?? ((s: string) => s);
	const fg = opts.fg;
	const inner = width - CHROME;
	const dashes = "─".repeat(width - 2);

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
		const padded = pad > 0 ? content + " ".repeat(pad) : truncateToWidth(content, inner);
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

export const DEFAULT_MODAL_HEIGHT_PERCENT = 80;
/** Fail-closed floor for ordinary overlays. Compare against modalHeight(), not raw rows. */
export const MIN_MODAL_HEIGHT = 6;
/** Fail-closed floor for permission overlays. Compare against modalHeight(), not raw rows. */
export const MIN_PERMISSION_MODAL_HEIGHT = 12;

/** Rows a modal may occupy: `percent` of the terminal, never more than it has. */
export function modalHeight(terminalRows: number, percent = DEFAULT_MODAL_HEIGHT_PERCENT): number {
	const rows = Number.isFinite(terminalRows) ? Math.max(1, Math.floor(terminalRows)) : 24;
	const ratio = Math.min(100, Math.max(1, percent)) / 100;
	return Math.max(1, Math.min(rows, Math.floor(rows * ratio)));
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

// ── Sectioned frame ───────────────────────────────────────────────────────────

export interface ViewportState {
	start: number;
	end: number;
	total: number;
	hiddenBefore: number;
	hiddenAfter: number;
}

export interface ModalFrameOptions extends Omit<FrameOptions, "lines"> {
	/** Hard cap on returned rows, borders included. */
	maxHeight: number;
	/** Pinned rows above the body (title etc.). */
	header?: string[];
	/** Variable rows — the only region that pages. */
	body: string[];
	/** Pinned rows below the body (controls, help). */
	footer?: string[];
	bodyOffset?: number;
	/** Styled by the caller; shown directly above the body when rows are hidden. */
	overflowLine?: (state: ViewportState) => string;
}

export interface ModalFrameResult {
	lines: string[];
	bodyOffset: number;
	maxBodyOffset: number;
	visibleBodyLines: number;
	/** False when pinned rows plus one body row cannot fit — callers must fail closed. */
	pinnedRowsFit: boolean;
}

const defaultOverflowLine = ({ start, end, total }: ViewportState) =>
	`PageUp/PageDown inspect • ${start + 1}–${end}/${total}`;

/**
 * Render a modal whose pinned header/footer rows always survive and whose body
 * is paged. Never returns more than `maxHeight` rows, and delegates all styling
 * to frameLines() so ANSI/fg/bg handling has exactly one implementation.
 */
export function frameModal(opts: ModalFrameOptions): ModalFrameResult {
	const { width, maxHeight, body, color, bg, fg, top } = opts;
	const header = opts.header ?? [];
	const footer = opts.footer ?? [];
	const overflowLine = opts.overflowLine ?? defaultOverflowLine;

	const cap = Number.isFinite(maxHeight) ? Math.max(1, Math.floor(maxHeight)) : 1;
	const diagnostic = "Terminal too short — resize or press esc to cancel";
	if (cap < 3) {
		return {
			lines: [truncateToWidth(diagnostic, Math.max(1, width))].slice(0, cap),
			bodyOffset: 0,
			maxBodyOffset: 0,
			visibleBodyLines: 0,
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
		const diag = [...(header.length > 0 ? [header[0] as string] : []), diagnostic].slice(
			0,
			Math.max(1, cap - 2),
		);
		return {
			lines: frameLines({ width, lines: diag, color, bg, fg }),
			bodyOffset: 0,
			maxBodyOffset: 0,
			visibleBodyLines: 0,
			pinnedRowsFit: false,
		};
	}

	const visibleBodyLines = overflows ? bodyBudget - 1 : bodyBudget;
	const maxBodyOffset = Math.max(0, body.length - visibleBodyLines);
	const offset = Math.min(Math.max(0, Math.floor(opts.bodyOffset ?? 0)), maxBodyOffset);

	const end = Math.min(body.length, offset + visibleBodyLines);
	const lines = [...header];
	if (overflows) {
		lines.push(
			overflowLine({
				start: offset,
				end,
				total: body.length,
				hiddenBefore: offset,
				hiddenAfter: body.length - end,
			}),
		);
	}
	lines.push(...body.slice(offset, end), ...footer);

	return {
		lines: frameLines({ width, lines, color, bg, fg, top }),
		bodyOffset: offset,
		maxBodyOffset,
		visibleBodyLines,
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
