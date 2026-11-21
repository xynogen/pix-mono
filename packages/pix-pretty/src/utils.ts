import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getCapabilities, hyperlink, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { ANSI_CAPTURE_RE, BG_BASE, FG_LNUM, RST } from "./ansi.ts";
import { MAX_PREVIEW_LINES } from "./config.ts";
import type { TextComponentCtor, TextComponentLike } from "./types.ts";

function preserveToolBackground(ansi: string, bg: string): string {
	return ansi.replace(ANSI_CAPTURE_RE, (seq, params: string) => {
		const codes = params.split(";");
		return params === "0" || codes.includes("49") ? `${seq}${bg}` : seq;
	});
}

export function fillToolBackground(text: string, bg = BG_BASE, width?: number): string {
	const resolvedWidth = width ?? terminalWidth();
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
	render(width: number): readonly string[];
	invalidate(): void;
};

// ponytail: 4 widths cover drag/split/fullscreen toggles. The ceiling is memory
// (4 × card size). Raise MAX_WIDTHS if the profile `resize` column shows misses.
const MAX_WIDTHS = 4;

type ViewportEntry = {
	/** Raw line → line fitted to this width. */
	lines: Map<string, string>;
	/** Inner render output for the current text at this width. */
	rendered: readonly string[] | undefined;
};

class ViewportText implements TextComponentLike, ViewportComponent {
	private text = "";
	// Pi re-renders every frame (spinner, streaming, resize). One entry per recent
	// width holds that width's line cache and the inner render output.
	//  - Idle frame (same text + width): return the cached lines. No pi-tui call.
	//  - Streaming (text grows, same width): the line cache fits only new or changed lines.
	//  - Resize back to a recent width: return that width's cached lines.
	// The returned array is shared by reference. pi-tui treats render output as read-only.
	private widths = new Map<number, ViewportEntry>();
	// The inner component holds one text. Track it, so a fit that gives the same
	// text does not force pi-tui to wrap again.
	private innerText: string | undefined;

	constructor(private readonly component: TextComponentLike) {}

	setText(value: string): void {
		if (value === this.text) return;
		this.text = value;
		// Render output is stale. Line caches stay valid, because they key on the raw line.
		for (const entry of this.widths.values()) entry.rendered = undefined;
	}

	getText(): string {
		return this.text;
	}

	render(width: number): readonly string[] {
		let entry = this.widths.get(width);
		if (entry) {
			// Refresh recency: Map keeps insertion order, so re-insert moves it to the end.
			this.widths.delete(width);
			this.widths.set(width, entry);
		} else {
			entry = { lines: new Map(), rendered: undefined };
			this.widths.set(width, entry);
			if (this.widths.size > MAX_WIDTHS) {
				const oldest = this.widths.keys().next().value;
				if (oldest !== undefined) this.widths.delete(oldest);
			}
		}
		if (entry.rendered) return entry.rendered;

		const cache = entry.lines;
		const lines = this.text.split("\n");
		// Bound the cache so a long streaming log cannot grow it without limit.
		if (cache.size > 4 * lines.length + 256) cache.clear();
		const fittedText = lines
			.map((line) => {
				let fitted = cache.get(line);
				if (fitted === undefined) {
					fitted = truncateToWidth(line, width, "");
					cache.set(line, fitted);
				}
				return fitted;
			})
			.join("\n");
		if (fittedText !== this.innerText) {
			this.component.setText(fittedText);
			this.innerText = fittedText;
		}
		entry.rendered = this.component.render?.(width) ?? fittedText.split("\n");
		return entry.rendered;
	}

	invalidate(): void {
		// invalidate = output stale for reasons other than (text, width): a theme or
		// style change. Fitting is pure on (text, width), so line caches stay valid.
		// The render output (colors) may differ, so drop every width's render memo.
		for (const entry of this.widths.values()) entry.rendered = undefined;
		this.component.invalidate?.();
	}
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

let _cachedTermW: number | undefined;
let _termWResizeBound = false;

function _bindTermWResize(): void {
	if (_termWResizeBound) return;
	_termWResizeBound = true;
	// Persistent listeners: every SIGWINCH invalidates the cache so the next
	// terminalWidth() re-reads. `.once` only caught the first resize, leaving width
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
export function terminalWidth(): number {
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
	// isAbsolute: on Windows, relative() across drives returns the absolute target.
	if (!r.startsWith("..") && !isAbsolute(r)) return r;
	// Empty home (unset HOME) must not match: "".replace would prefix every path with "~".
	return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/**
 * shortPath() wrapped in an OSC 8 `file://` link when the terminal supports it
 * (pi-tui detects support, including tmux/screen). Width math and truncation in
 * pi-tui skip OSC 8, and terminals without it get plain text.
 */
export function linkedShortPath(cwd: string, home: string, p: string): string {
	const text = shortPath(cwd, home, p);
	if (!text || !getCapabilities().hyperlinks) return text;
	return hyperlink(text, pathToFileURL(resolve(cwd, p)).href);
}

export function lineNumber(n: number, w: number): string {
	const v = String(n);
	return `${FG_LNUM}${" ".repeat(Math.max(0, w - v.length))}${v}${RST}`;
}
