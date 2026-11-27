import {
	Markdown,
	sliceByColumn,
	stripTerminalSequences,
	type Theme,
	visibleWidth,
} from "@xynogen/pix-pretty/tui";
import type { ExtensionAPI } from "@xynogen/pix-runtime/host";
import { wrapMethod } from "@xynogen/pix-runtime/patch";
import { themeAfterSessionStart } from "./code-blocks.ts";

type TableTheme = Pick<Theme, "bold" | "fg">;
type Align = "left" | "center" | "right" | null;
type Cell = { text: string; tokens?: readonly unknown[] };
type TableToken = { raw?: string; align?: readonly Align[]; header: Cell[]; rows: Cell[][] };
type Sort = { col: number; desc: boolean };
type HeaderHit = { numeric: boolean[]; lines: Set<string> };
type Click = { type: string; button: string; x: number; y: number; width: number };

const CORNERS: Record<string, string> = { "┌": "╭", "┐": "╮", "└": "╰", "┘": "╯" };
const HEAVY: Record<string, string> = { "├": "┝", "─": "━", "┼": "┿", "┤": "┥" };
// Pi pads each cell with plain spaces, sometimes inside its closing style codes.
const TRAILING_PAD_RE = /(?: |\x1b\[[0-9;]*m)+$/;
// Pi's text-style reset between wrapped cell fragments, plus the background: the slice
// drops a style close that sits exactly on the column edge, such as a badge's tint.
const STYLE_RESET = "\x1b[22;23;24;25;27;28;29;39;49m";

let activeTheme: TableTheme | undefined;
// Sort per table source, so it survives re-renders.
const sorts = new Map<string, Sort>();
// Per Markdown: each table's source → its clickable header rows (plain text).
const headers = new WeakMap<object, Map<string, HeaderHit>>();
// Column borders in any table row: plain, styled, top border and header rule.
const SEPARATORS = new Set("│┌┐╭╮┬├┤┼┝┥┿");
const segmenter = new Intl.Segmenter();

// A whole cell that is a number: `3,781`, `-2.5`, `84%`, `12 ms`. Not a version like `0.8.0`.
const NUMBER = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*(?:%|[a-zA-Z]{1,3})?$/;

const plainCell = (text: string) => text.replace(/[*_`~]/g, "").trim();

export function cellNumber(text: string): number | undefined {
	const plain = plainCell(text);
	return NUMBER.test(plain) ? Number.parseFloat(plain.replaceAll(",", "")) : undefined;
}

export function isNumericColumn(rows: readonly (readonly Cell[])[], col: number): boolean {
	const cells = rows.map((row) => plainCell(row[col]?.text ?? "")).filter(Boolean);
	return cells.length > 0 && cells.every((cell) => cellNumber(cell) !== undefined);
}

/** Rows sorted by one column; empty cells stay last. Numbers by value, text A-Z with natural digits. */
export function sortRows<T extends Cell>(
	rows: readonly T[][],
	col: number,
	desc: boolean,
	numeric: boolean,
): T[][] {
	const key = (row: readonly T[]) => plainCell(row[col]?.text ?? "");
	const compare = (a: string, b: string) =>
		numeric
			? (cellNumber(a) ?? 0) - (cellNumber(b) ?? 0)
			: a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
	return [...rows].sort((rowA, rowB) => {
		const a = key(rowA);
		const b = key(rowB);
		if (!a || !b) return a ? -1 : b ? 1 : 0;
		return desc ? compare(b, a) : compare(a, b);
	});
}

/**
 * Column under terminal column `x` of a plain table row, from the row's own borders: a
 * column spans its left border up to the next one, so a click on a border still counts.
 */
export function columnAt(plain: string, x: number): number | undefined {
	const borders: number[] = [];
	let at = 0;
	for (const { segment } of segmenter.segment(plain)) {
		if (SEPARATORS.has(segment)) borders.push(at);
		at += visibleWidth(segment);
	}
	const last = borders.length - 1;
	if (last < 1 || x < (borders[0] ?? 0) || x > (borders[last] ?? 0)) return undefined;
	const col = borders.findIndex((edge) => x < edge) - 1;
	return col < 0 ? last - 1 : col;
}

/** A copy of the table token with rows sorted and an arrow on the sorted header. */
function sortedToken(token: TableToken, sort: Sort): TableToken {
	const arrow = { type: "text", raw: "", text: sort.desc ? " ▼" : " ▲" };
	const header = token.header.map((cell, i) =>
		i === sort.col ? { ...cell, tokens: [...(cell.tokens ?? []), arrow] } : cell,
	);
	const numeric = isNumericColumn(token.rows, sort.col);
	return { ...token, header, rows: sortRows(token.rows, sort.col, sort.desc, numeric) };
}

/** Remember a table's header block (top border, header rows, rule) so a click there sorts it. */
function rememberHeader(owner: object, token: TableToken, lines: readonly string[]): void {
	const plain = lines.map((line) => stripTerminalSequences(line).trim());
	// Pi falls back to raw Markdown when the table cannot fit: nothing to click.
	if (!token.raw || !/^[┌╭]/.test(plain[0] ?? "")) return;
	const rule = plain.findIndex((line) => /^[├┝]/.test(line));
	const hits = headers.get(owner) ?? new Map<string, HeaderHit>();
	headers.set(owner, hits);
	hits.set(token.raw, {
		numeric: token.header.map((_, i) => isNumericColumn(token.rows, i)),
		lines: new Set(plain.slice(0, rule < 0 ? 2 : rule + 1)),
	});
}

/** The table a clicked row belongs to. Two tables can share a row (same widths): the k-th match wins. */
function tableAt(
	owner: Markdown,
	lines: readonly string[],
	y: number,
): { raw: string; hit: HeaderHit } | undefined {
	const hits = headers.get(owner);
	const row = lines[y];
	if (!hits || row === undefined) return undefined;
	const plain = stripTerminalSequences(row).trim();
	// Current tables in text order; a streamed table leaves stale partial sources behind.
	const tokens: unknown = Reflect.get(owner, "cachedTokens")?.deref()?.tokens;
	const order = Array.isArray(tokens)
		? tokens.filter((t) => t?.type === "table").map((t) => String(t.raw))
		: [...hits.keys()];
	const matches = order.filter((raw) => hits.get(raw)?.lines.has(plain));
	const before = lines.slice(0, y).filter((line) => stripTerminalSequences(line).trim() === plain);
	const raw = matches[before.length];
	const hit = raw === undefined ? undefined : hits.get(raw);
	return raw !== undefined && hit ? { raw, hit } : undefined;
}

/** Left click anywhere in a header block: sort by that column; again on it reverses. */
function sortOnClick(this: Markdown, event: Click): { handled: true } | undefined {
	if (event.type !== "click" || event.button !== "left") return undefined;
	const lines = this.render(event.width);
	const table = tableAt(this, lines, event.y);
	if (!table) return undefined;
	// The untrimmed row keeps the left padding, so `x` maps straight to its borders.
	const col = columnAt(stripTerminalSequences(lines[event.y] ?? ""), event.x);
	if (col === undefined) return undefined;
	const prev = sorts.get(table.raw);
	// Numbers start large to small, text A-Z.
	const desc = prev?.col === col ? !prev.desc : (table.hit.numeric[col] ?? false);
	sorts.set(table.raw, { col, desc });
	this.invalidate();
	return { handled: true };
}

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
			function renderStyledTable(this: object, token: TableToken, ...rest: unknown[]) {
				const sort = token.raw ? sorts.get(token.raw) : undefined;
				const lines: string[] = native.call(this, sort ? sortedToken(token, sort) : token, ...rest);
				const styled = activeTheme ? styleTable(lines, token.align ?? [], activeTheme) : lines;
				rememberHeader(this, token, styled);
				return styled;
			},
	);
	// Markdown has no mouse handler of its own; Pi routes clicks to any component with one.
	Object.defineProperty(Markdown.prototype, "handleMouse", {
		configurable: true,
		writable: true,
		value: sortOnClick,
	});
}

export default function tablesExtension(pi: ExtensionAPI): void {
	patchTableRenderer();
	pi.on("session_start", (_event, ctx) => {
		activeTheme = themeAfterSessionStart(activeTheme, ctx.mode, ctx.ui.theme);
	});
}
