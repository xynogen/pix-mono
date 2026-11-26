import { Markdown, sliceByColumn, type Theme, visibleWidth } from "@xynogen/pix-pretty/tui";
import type { ExtensionAPI } from "@xynogen/pix-runtime/host";
import { wrapMethod } from "@xynogen/pix-runtime/patch";
import { themeAfterSessionStart } from "./code-blocks.ts";

type TableTheme = Pick<Theme, "bold" | "fg">;
type Align = "left" | "center" | "right" | null;

const CORNERS: Record<string, string> = { "┌": "╭", "┐": "╮", "└": "╰", "┘": "╯" };
const HEAVY: Record<string, string> = { "├": "┝", "─": "━", "┼": "┿", "┤": "┥" };
// Pi pads each cell with plain spaces, sometimes inside its closing style codes.
const TRAILING_PAD_RE = /(?: |\x1b\[[0-9;]*m)+$/;
// Pi's text-style reset between wrapped cell fragments, plus the background: the slice
// drops a style close that sits exactly on the column edge, such as a badge's tint.
const STYLE_RESET = "\x1b[22;23;24;25;27;28;29;39;49m";

let activeTheme: TableTheme | undefined;

function alignCell(cell: string, width: number, align: Align | undefined): string {
	const tail = cell.match(TRAILING_PAD_RE)?.[0] ?? "";
	const text = cell.slice(0, cell.length - tail.length) + tail.replaceAll(" ", "");
	const gap = Math.max(0, width - visibleWidth(text));
	const left = align === "right" ? gap : align === "center" ? Math.floor(gap / 2) : 0;
	return `${" ".repeat(left)}${text}${STYLE_RESET}${" ".repeat(gap - left)}`;
}

/**
 * Restyle Pi's box table: dim rounded borders, column alignment, an accent header and a
 * heavy rule under it.
 * No background fill: a cell-wide fill overhangs the half-cell `│` borders, and some
 * themes and terminals show it barely or not at all, so the table looks the same everywhere.
 */
export function styleTable(
	lines: readonly string[],
	align: readonly Align[],
	theme: TableTheme,
): string[] {
	const top = lines[0];
	// Pi falls back to raw Markdown when the table cannot fit.
	if (!top?.startsWith("┌")) return [...lines];
	const widths = top
		.slice(2, -2)
		.split("─┬─")
		.map((cell) => cell.length);
	const border = (text: string) => theme.fg("borderMuted", text);
	const bar = border("│");
	let header = true;
	return lines.map((line) => {
		if (!line.startsWith("│")) {
			if (header && line.startsWith("├")) {
				header = false;
				return border(line.replace(/[├─┼┤]/g, (c) => HEAVY[c] ?? c));
			}
			return line && border(line.replace(/^[┌└]|[┐┘]$/g, (c) => CORNERS[c] ?? c));
		}
		let col = 2;
		const cells = widths.map((width, i) => {
			const cell = alignCell(sliceByColumn(line, col, width, true), width, align[i]);
			col += width + 3;
			return header ? theme.fg("accent", cell) : cell;
		});
		return `${bar} ${cells.join(` ${bar} `)} ${bar}`;
	});
}

function patchTableRenderer(): void {
	// A Pi release without this private method keeps its own table rendering.
	wrapMethod(
		Markdown.prototype,
		"renderTable",
		(native) =>
			function renderStyledTable(
				this: unknown,
				token: { align?: readonly Align[] },
				...rest: unknown[]
			) {
				const lines: string[] = native.call(this, token, ...rest);
				return activeTheme ? styleTable(lines, token.align ?? [], activeTheme) : lines;
			},
	);
}

export default function tablesExtension(pi: ExtensionAPI): void {
	patchTableRenderer();
	pi.on("session_start", (_event, ctx) => {
		activeTheme = themeAfterSessionStart(activeTheme, ctx.mode, ctx.ui.theme);
	});
}
