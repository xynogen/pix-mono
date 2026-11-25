export let RST = "\x1b[0m";
export const BOLD = "\x1b[1m";
export const BOLD_OFF = "\x1b[22m";

export const FG_LNUM = "\x1b[38;2;100;100;100m";
export const FG_DIM = "\x1b[38;2;80;80;80m";
export const FG_RULE = "\x1b[38;2;50;50;50m";
export const FG_GREEN = "\x1b[38;2;100;180;120m";
export const FG_RED = "\x1b[38;2;200;100;100m";
export const FG_YELLOW = "\x1b[38;2;220;180;80m";
export const FG_BLUE = "\x1b[38;2;100;140;220m";
const FG_MUTED = "\x1b[38;2;139;148;158m";

const BG_DEFAULT = "\x1b[49m";
export let BG_BASE = BG_DEFAULT;
export let BG_ERROR = BG_DEFAULT;

/** Tool and diff renderers always preserve the terminal background. */
export function resolveBaseBackground(_theme: unknown): void {
	BG_BASE = BG_DEFAULT;
	BG_ERROR = BG_DEFAULT;
	RST = "\x1b[0m";
}

export const ANSI_CAPTURE_RE = /\x1b\[([0-9;]*)m/g;

/** The ESC byte that opens every ANSI escape sequence. */
export const ESC = "\x1b";

/** True when a string already contains an ANSI escape sequence. */
export function hasAnsi(s: string): boolean {
	return s.includes(ESC);
}

/**
 * Re-open `bgOpen`/`fgOpen` after every reset inside `s`: `\x1b[0m` clears both, `49`
 * clears the background, `39` the foreground. Keeps a panel color solid behind
 * embedded content that ends its own styles with a full reset.
 */
export function reopenAfterResets(s: string, bgOpen: string, fgOpen = ""): string {
	if (!bgOpen && !fgOpen) return s;
	return s.replace(ANSI_CAPTURE_RE, (seq, params: string) => {
		let bgReset = false;
		let fgReset = false;
		const codes = params === "" ? [0] : params.split(";").map(Number);
		for (let i = 0; i < codes.length; i++) {
			const code = codes[i];
			// 38/48 carry color arguments (`5;n` or `2;r;g;b`); a 49 there is not a reset.
			if (code === 38 || code === 48) i += codes[i + 1] === 5 ? 2 : 4;
			else if (code === 0) bgReset = fgReset = true;
			else if (code === 49) bgReset = true;
			else if (code === 39) fgReset = true;
		}
		return `${seq}${bgReset ? bgOpen : ""}${fgReset ? fgOpen : ""}`;
	});
}

/** A `Box` background function that stays solid behind content with embedded resets. */
export function solidBackground(bg: (text: string) => string): (text: string) => string {
	const bgOpen = bg("\x00").split("\x00")[0] ?? "";
	return (text) => bg(reopenAfterResets(text, bgOpen));
}

// ---------------------------------------------------------------------------
// Low-contrast fix (same as pi-diff)
// ---------------------------------------------------------------------------

function isLowContrastShikiFg(params: string): boolean {
	if (params === "30" || params === "90") return true;
	if (params === "38;5;0" || params === "38;5;8") return true;
	if (!params.startsWith("38;2;")) return false;
	const parts = params.split(";").map(Number);
	if (parts.length !== 5 || parts.some((n) => !Number.isFinite(n))) return false;
	const [, , r = 0, g = 0, b = 0] = parts;
	const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
	return luminance < 72;
}

export function normalizeShikiContrast(ansi: string): string {
	return ansi.replace(ANSI_CAPTURE_RE, (seq, params: string) =>
		isLowContrastShikiFg(params) ? FG_MUTED : seq,
	);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
