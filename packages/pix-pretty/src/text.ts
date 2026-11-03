import {
	mixColors,
	sliceByColumn,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Horizontal fade for ONE plain line: fit `text` to `width` columns and fade its last
 * `fadeColumns` columns instead of cutting with "…". Use it instead of `truncateToWidth`.
 *
 *   fadeText("Write a Conventional Commit message", 20, fadePaint(theme))
 *   → "Write a Conventional"   (20 columns; "ventional" gets fainter to the right)
 *
 * Input styling and control chars are stripped; `paint(text, fade)` restyles every
 * piece (fade 0 = normal … 1 = background). Use {@link fadePaint} for the pix look.
 * `paint` must not change width. Text that fits is painted with fade 0, uncut.
 */
export function fadeText(
	text: string,
	width: number,
	paint: (text: string, fade: number) => string,
	fadeColumns = 8,
): string {
	if (!Number.isFinite(width) || width < 1) return "";
	const columns = Math.floor(width);
	const plain = stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
	if (visibleWidth(plain) <= columns) return paint(plain, 0);
	const clipped = sliceByColumn(plain, 0, columns, true);
	const end = visibleWidth(clipped);
	const fadeWidth = Number.isFinite(fadeColumns) ? Math.max(0, Math.floor(fadeColumns)) : 8;
	if (!fadeWidth) return paint(clipped, 0);
	const start = Math.max(0, end - fadeWidth);
	let column = 0;
	let head = "";
	let output = "";
	for (const { segment } of graphemes.segment(clipped)) {
		column += visibleWidth(segment);
		if (column <= start) head += segment;
		else {
			if (head) {
				output += paint(head, 0);
				head = "";
			}
			output += paint(segment, (column - start) / (end - start));
		}
	}
	return output;
}

/**
 * Horizontal fade for ONE already-styled line. Like {@link fadeText}, but the head keeps
 * its own colors: only the last `fadeColumns` columns are restyled through `paint`.
 * A line that fits is returned unchanged. Widgets and modal rows use this.
 */
export function fadeLine(
	line: string,
	width: number,
	paint: (text: string, fade: number) => string,
	fadeColumns = 8,
): string {
	if (!Number.isFinite(width) || width < 1) return "";
	const columns = Math.floor(width);
	if (visibleWidth(line) <= columns) return line;
	const head = truncateToWidth(line, Math.max(0, columns - fadeColumns), "");
	const headWidth = visibleWidth(head);
	const rest = sliceByColumn(stripTerminalSequences(line), headWidth, columns - headWidth + 1);
	return head + fadeText(rest, columns - headWidth, paint, fadeColumns);
}

/** Theme slice the fade helpers read; colors/style are optional so plain themes still work. */
export type FadeTheme = {
	fg: (key: "dim" | "muted", text: string) => string;
	colors?: {
		dim: Parameters<typeof mixColors>[0];
		customMessageBg: Parameters<typeof mixColors>[1];
	};
	style?: (text: string, style: { fg: ReturnType<typeof mixColors> }) => string;
};

/**
 * The standard pix fade color, as a `paint` for {@link fadeText} / {@link fadeLine}.
 * fade 0 is the `dim` role; higher values mix `dim` toward `customMessageBg`, so text
 * sinks into the background. Themes without color data paint every faded cell `muted`.
 */
export function fadePaint(theme: FadeTheme): (text: string, fade: number) => string {
	return (text, fade) => {
		if (fade === 0) return theme.fg("dim", text);
		if (!theme.colors || !theme.style) return theme.fg("muted", text);
		return theme.style(text, {
			fg: mixColors(theme.colors.dim, theme.colors.customMessageBg, fade),
		});
	};
}

/**
 * Vertical fade for a MULTI-line body: a collapsed tool-result preview. Keeps the first
 * `maxLines` rows, fades the last `fadeRows` of them toward the background, then adds
 * `hint(hidden)` (e.g. "ctrl+o +23 lines"). Use it instead of a hard cut + "… N more".
 *
 *   row 1..5   unchanged
 *   row 6      faint      ↑
 *   row 7      fainter    │ fadeRows = 3
 *   row 8      faintest   ↓ (stops at 85%, still readable)
 *   hint(22)
 *
 * Faded rows lose their own styling. A body with ≤ `maxLines` rows returns unchanged.
 * Callers show the full body when the result is expanded.
 */
export function fadeTextRow(
	body: string,
	theme: FadeTheme,
	hint: (hidden: number) => string,
	maxLines = 8,
	fadeRows = 3,
): string {
	const lines = body.split("\n");
	if (lines.length <= maxLines) return body;
	return [...fadeRowsOf(lines, theme, maxLines, fadeRows), hint(lines.length - maxLines)].join(
		"\n",
	);
}

/**
 * Array form of {@link fadeTextRow} for renderers that build `string[]` rows: the first
 * `maxLines` rows, the last `fadeRows` of them fading. Returns all rows unchanged when
 * they fit, so `fadeRowsOf(lines, theme, expanded ? Infinity : MAX)` replaces
 * `lines.slice(0, max)`. The caller adds its own "… N more" / hint row.
 */
export function fadeRowsOf(
	lines: string[],
	theme: FadeTheme,
	maxLines: number,
	fadeRows = 3,
): string[] {
	if (lines.length <= maxLines) return lines;
	const paint = fadePaint(theme);
	// At most a third of the preview fades, so short previews stay readable.
	const rows = Math.min(fadeRows, Math.floor(maxLines / 3));
	return lines.slice(0, maxLines).map((line, i) => {
		const step = i - (maxLines - rows) + 1;
		if (step <= 0) return line;
		// Keep leading padding uncolored; stop at 0.85 so the last row stays faintly readable.
		const plain = stripTerminalSequences(line);
		const text = plain.trimStart();
		if (!text) return plain;
		return plain.slice(0, plain.length - text.length) + paint(text, (step / (rows + 1)) * 0.85);
	});
}
