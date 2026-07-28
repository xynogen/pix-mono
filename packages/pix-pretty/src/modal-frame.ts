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

/** Clamp terminal width to a sane modal width (40–96 cols). */
export function modalWidth(termWidth: number): number {
	return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, termWidth - MARGIN));
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
	const { width, lines, color, top } = opts;
	const bg = opts.bg ?? ((s: string) => s);
	const fg = opts.fg;
	const inner = Math.max(1, width - CHROME);
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
