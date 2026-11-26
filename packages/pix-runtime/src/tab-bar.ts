/**
 * Tab bars shared by `/pix` (top tabs, `tab` key) and its sub-tabs (`` ` `` key).
 * Lives in runtime because `/pix` renders here and pix-pretty depends on runtime, not the reverse.
 *
 * The two levels look different on purpose: top tabs are a `│`-separated bar, sub-tabs are
 * `●`/`○` chips under it, so a glance tells which bar `tab` and `` ` `` move.
 */

import { decodeKittyPrintable, Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";

interface TabTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

type Cell = (name: string, active: boolean) => string;

/**
 * Fit `names` into `width` as a window around `current`, joined by `sep`, with `‹`/`›`
 * marking hidden names on each side.
 */
function fitBar(
	names: readonly string[],
	current: string,
	theme: TabTheme,
	width: number,
	cell: Cell,
	sep: string,
): string {
	const bar = (from: number, to: number) =>
		(from > 0 ? theme.fg("muted", "‹") : "") +
		names
			.slice(from, to)
			.map((name) => cell(name, name === current))
			.join(sep) +
		(to < names.length ? theme.fg("muted", "›") : "");
	const at = Math.max(0, names.indexOf(current));
	let [from, to] = [at, at + 1];
	// Grow right first, then left, while the window still fits.
	for (let grew = true; grew; ) {
		grew = false;
		if (to < names.length && visibleWidth(bar(from, to + 1)) <= width) [to, grew] = [to + 1, true];
		if (from > 0 && visibleWidth(bar(from - 1, to)) <= width) [from, grew] = [from - 1, true];
	}
	return bar(from, to);
}

/** Top tabs: `  A  │  B  │  C  ` with the current tab bold accent. */
export function renderTabBar(
	names: readonly string[],
	current: string,
	theme: TabTheme,
	width: number,
): string {
	const cell: Cell = (name, active) =>
		active ? theme.fg("accent", theme.bold(`  ${name}  `)) : theme.fg("muted", `  ${name}  `);
	return fitBar(names, current, theme, width, cell, theme.fg("muted", "│"));
}

/** Full-width muted rule under a tab bar: top tabs, sub-tabs and content each sit on their own level. */
export function renderTabRule(theme: Pick<TabTheme, "fg">, width: number): string {
	return theme.fg("borderMuted", "─".repeat(Math.max(1, width)));
}

/** Sub-tabs: `  ● A   ○ B   ○ C` under the top bar, indented and without separators. */
export function renderSubTabBar(
	names: readonly string[],
	current: string,
	theme: TabTheme,
	width: number,
): string {
	const cell: Cell = (name, active) =>
		active ? theme.fg("accent", `● ${theme.bold(name)}`) : theme.fg("muted", `○ ${name}`);
	return `  ${fitBar(names, current, theme, Math.max(1, width - 2), cell, "   ")}`;
}

/**
 * The sub-tab key: backtick, one key with no shift. Kitty may send it as a CSI-u code;
 * the printable text is checked as well as the key id.
 */
export function isSubTabKey(data: string): boolean {
	return matchesKey(data, Key.backtick) || decodeKittyPrintable(data) === "`";
}

/** The next name after `current`, wrapping; the first name when `current` is not listed. */
export function nextTab(names: readonly string[], current: string): string {
	const at = names.indexOf(current);
	return names[(at + 1) % names.length] ?? current;
}
