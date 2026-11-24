import { Markdown, sliceByColumn, type Theme, visibleWidth } from "@xynogen/pix-pretty/tui";
import type { ExtensionAPI } from "@xynogen/pix-runtime/host";
import { themeAfterSessionStart } from "./code-blocks.ts";

type TableTheme = Pick<Theme, "bg" | "bold" | "fg">;
type Align = "left" | "center" | "right" | null;
type RenderTable = (
	this: unknown,
	token: { align?: readonly Align[] },
	...rest: unknown[]
) => string[];

const PATCHED = Symbol.for("@xynogen/pix-display:table-renderer");
const CORNERS: Record<string, string> = { "┌": "╭", "┐": "╮", "└": "╰", "┘": "╯" };
// Pi pads each cell with plain spaces, sometimes inside its closing style codes.
const TRAILING_PAD_RE = /(?: |\x1b\[[0-9;]*m)+$/;
// Same text-style reset Pi uses between wrapped cell fragments; the slice drops a
// style close that sits exactly on the column edge.
const STYLE_RESET = "\x1b[22;23;24;25;27;28;29;39m";

let activeTheme: TableTheme | undefined;

function alignCell(cell: string, width: number, align: Align | undefined): string {
	const tail = cell.match(TRAILING_PAD_RE)?.[0] ?? "";
	const text = cell.slice(0, cell.length - tail.length) + tail.replaceAll(" ", "");
	const gap = Math.max(0, width - visibleWidth(text));
	const left = align === "right" ? gap : align === "center" ? Math.floor(gap / 2) : 0;
	return `${" ".repeat(left)}${text}${STYLE_RESET}${" ".repeat(gap - left)}`;
}

/**
 * Restyle Pi's box table: dim rounded borders, column alignment, an accent header on
 * `selectedBg` and zebra-striped body rows on `toolPendingBg`. A stripe covers every
 * wrapped line of its row.
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
	let row = -1;
	return lines.map((line) => {
		if (!line.startsWith("│")) {
			if (line.startsWith("├")) row++;
			return line && border(line.replace(/^[┌└]|[┐┘]$/g, (c) => CORNERS[c] ?? c));
		}
		let col = 2;
		const cells = widths.map((width, i) => {
			const cell = alignCell(sliceByColumn(line, col, width, true), width, align[i]);
			col += width + 3;
			return row < 0 ? theme.fg("accent", cell) : cell;
		});
		const styled = `${bar} ${cells.join(` ${bar} `)} ${bar}`;
		if (row < 0) return theme.bg("selectedBg", styled);
		return row % 2 === 1 ? theme.bg("toolPendingBg", styled) : styled;
	});
}

function patchTableRenderer(): void {
	const prototype = Markdown.prototype;
	if (Reflect.get(prototype, PATCHED)) return;
	const native: unknown = Reflect.get(prototype, "renderTable");
	// A Pi release without this private method keeps its own table rendering.
	if (typeof native !== "function") return;
	const renderStyledTable: RenderTable = function renderStyledTable(token, ...rest) {
		const lines: string[] = native.call(this, token, ...rest);
		return activeTheme ? styleTable(lines, token.align ?? [], activeTheme) : lines;
	};
	Reflect.set(prototype, "renderTable", renderStyledTable);
	Reflect.set(prototype, PATCHED, true);
}

export default function tablesExtension(pi: ExtensionAPI): void {
	patchTableRenderer();
	pi.on("session_start", (_event, ctx) => {
		activeTheme = themeAfterSessionStart(activeTheme, ctx.mode, ctx.ui.theme);
	});
}
