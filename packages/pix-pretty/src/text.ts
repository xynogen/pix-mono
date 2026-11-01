import {
	sliceByColumn,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Fit one line to terminal columns, fading only overflow. Input styling/controls are
 * stripped; paint owns styling (0 = normal, 1 = background). It must not change width.
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
 * Fit an already-styled line: unchanged when it fits, otherwise the head keeps its styling
 * and the last `fadeColumns` columns fade through `paint`. Widgets use this instead of "…".
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
