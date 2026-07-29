// Split / unified / word-level diff rendering — ported from
// @heyhuynhgiabuu/pi-diff (src/index.ts render core) and adapted to the
// vendored pretty extension's primitives (cli-highlight `hlBlock`, shared
// theme-aware `RST`/`BG_BASE` from ansi.ts).
//
// Engine note: pi-diff used Shiki's codeToANSI. pretty uses cli-highlight,
// shared with other pix-pretty renderers, and paints foreground tokens only.

import { config } from "@xynogen/pix-runtime/config";
import { prettySection } from "@xynogen/pix-runtime/sections";
import * as Diff from "diff";
import { BG_BASE, BOLD, FG_DIM, FG_GREEN, FG_LNUM, FG_RED, FG_RULE, RST } from "./ansi.js";
import { MAX_HL_CHARS, MAX_RENDER_LINES, WORD_DIFF_MIN_SIM } from "./config.js";
import type { DiffLine, ParsedDiff } from "./diff.js";
import { hlBlock } from "./highlight.js";
import type { BundledLanguage, FgTheme } from "./types.js";
import { termW as utilsTermW } from "./utils.js";

// ---------------------------------------------------------------------------
// Env-overridable color/threshold helpers (mirror pi-diff)
// ---------------------------------------------------------------------------

function envInt(name: string, fallback: number): number {
	const v = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(v) ? v : fallback;
}

// ---------------------------------------------------------------------------
// Diff-specific ANSI. Theme-backed colors are resolved per render; these
// constants are readable fallbacks for hosts that do not expose raw theme ANSI.
// ---------------------------------------------------------------------------

const DIM = "\x1b[2m";
const dc = config(prettySection).diff;

// Diff add/remove share the canonical green/red from ansi.ts (single source).
const FG_ADD = FG_GREEN;
const FG_DEL = FG_RED;
const FG_STRIPE = "\x1b[38;2;40;40;40m"; // diagonal stripes on filler cells

const BORDER_BAR = "▌";
const DIVIDER = `${FG_RULE}│${RST}`;

const ESC_RE = "\u001b";
const ANSI_RE = new RegExp(`${ESC_RE}\\[[0-9;]*m`, "g");
const ANSI_CAPTURE_RE = new RegExp(`${ESC_RE}\\[([^m]*)m`, "g");

// ---------------------------------------------------------------------------
// Terminal bounds + thresholds
// ---------------------------------------------------------------------------

const MAX_TERM_WIDTH = 210;

const MAX_PREVIEW_LINES = envInt("PRETTY_MAX_PREVIEW_LINES", 80);

const SPLIT_MIN_WIDTH = envInt("DIFF_SPLIT_MIN_WIDTH", dc.splitMinWidth || 150);
const SPLIT_MIN_CODE_WIDTH = envInt("DIFF_SPLIT_MIN_CODE_WIDTH", dc.splitMinCodeWidth || 60);
const SPLIT_MAX_WRAP_RATIO = 0.2;
const SPLIT_MAX_WRAP_LINES = 8;

const MAX_WRAP_ROWS_WIDE = 3; // >=180 cols
const MAX_WRAP_ROWS_MED = 2; // 120-179 cols
const MAX_WRAP_ROWS_NARROW = 1; // <120 cols (truncate)

// ---------------------------------------------------------------------------
// Theme-aware diff colors
// ---------------------------------------------------------------------------

export interface DiffColors {
	fgAdd: string;
	fgDel: string;
	fgCtx: string;
	/** Active Pi theme, forwarded to syntax highlighting. */
	theme?: FgTheme;
	bgAdd: string;
	bgDel: string;
	bgAddHighlight: string;
	bgDelHighlight: string;
	bgGutterAdd: string;
	bgGutterDel: string;
}

// Faint row tints for changed lines. Kept dark enough to sit under syntax
// highlighting without washing it out, but visible enough that a scanned diff
// reads as add/remove bands rather than gutter chips alone.
const BG_ADD_FAINT = "\x1b[48;2;18;42;28m";
const BG_DEL_FAINT = "\x1b[48;2;48;22;26m";
/** Intra-line word-diff emphasis — one step brighter than the row tint. */
const BG_ADD_STRONG = "\x1b[48;2;28;72;44m";
const BG_DEL_STRONG = "\x1b[48;2;82;32;38m";

export const DEFAULT_DIFF_COLORS: DiffColors = {
	fgAdd: FG_ADD,
	fgDel: FG_DEL,
	fgCtx: FG_DIM,
	bgAdd: BG_ADD_FAINT,
	bgDel: BG_DEL_FAINT,
	bgAddHighlight: BG_ADD_STRONG,
	bgDelHighlight: BG_DEL_STRONG,
	bgGutterAdd: BG_ADD_FAINT,
	bgGutterDel: BG_DEL_FAINT,
};

type DiffTheme = {
	fg?: FgTheme["fg"];
	getFgAnsi?: (key: string) => string;
};

function themeFg(theme: DiffTheme, key: string, fallback: string): string {
	try {
		return theme.getFgAnsi?.(key) || fallback;
	} catch {
		return fallback;
	}
}

export function resolveDiffColors(theme?: DiffTheme): DiffColors {
	if (!theme) return DEFAULT_DIFF_COLORS;
	return {
		fgAdd: themeFg(theme, "toolDiffAdded", FG_ADD),
		fgDel: themeFg(theme, "toolDiffRemoved", FG_DEL),
		fgCtx: themeFg(theme, "toolDiffContext", FG_DIM),
		theme: typeof theme.fg === "function" ? (theme as FgTheme) : undefined,
		bgAdd: BG_ADD_FAINT,
		bgDel: BG_DEL_FAINT,
		bgAddHighlight: BG_ADD_STRONG,
		bgDelHighlight: BG_DEL_STRONG,
		bgGutterAdd: BG_ADD_FAINT,
		bgGutterDel: BG_DEL_FAINT,
	};
}

/** Stable cache key for the resolved diff theme colors. */
export function diffThemeCacheKey(theme?: DiffTheme): string {
	const { theme: _theme, ...colors } = resolveDiffColors(theme);
	return `${Object.values(colors).join("|")}|${BG_BASE}`;
}

// ---------------------------------------------------------------------------
// Adaptive helpers + utilities
// ---------------------------------------------------------------------------

function adaptiveWrapRows(tw?: number): number {
	const w = tw ?? termW();
	if (w >= 180) return MAX_WRAP_ROWS_WIDE;
	if (w >= 120) return MAX_WRAP_ROWS_MED;
	return MAX_WRAP_ROWS_NARROW;
}

function strip(s: string): string {
	return s.replace(ANSI_RE, "");
}

function tabs(s: string): string {
	return s.replace(/\t/g, "  ");
}

function termW(): number {
	// Single source of truth: utils.termW caches, falls back to tty ioctl, and
	// invalidates on resize. Diff layout needs a hard floor of 80 cols for the
	// split-view column math, so clamp the shared value here.
	return Math.max(80, Math.min(utilsTermW(), MAX_TERM_WIDTH));
}

/** Pad/truncate `s` to exactly `w` visible chars. ANSI-aware. */
function fit(s: string, w: number): string {
	if (w <= 0) return "";
	const plain = strip(s);
	if (plain.length <= w) return s + " ".repeat(w - plain.length);
	const showW = w > 2 ? w - 1 : w;
	let vis = 0;
	let i = 0;
	while (i < s.length && vis < showW) {
		if (s[i] === "\x1b") {
			const e = s.indexOf("m", i);
			if (e !== -1) {
				i = e + 1;
				continue;
			}
		}
		vis++;
		i++;
	}
	return w > 2 ? `${s.slice(0, i)}${RST}${FG_DIM}›${RST}` : `${s.slice(0, i)}${RST}`;
}

/** Extract last active fg + bg ANSI codes from a string (for wrap continuations). */
function ansiState(s: string): string {
	let fg = "";
	let bg = "";
	for (const match of s.matchAll(ANSI_CAPTURE_RE)) {
		const p = match[1] ?? "";
		const seq = match[0] ?? "";
		if (p === "0") {
			fg = "";
			bg = "";
		} else if (p === "39") {
			fg = "";
		} else if (p.startsWith("38;")) {
			fg = seq;
		} else if (p.startsWith("48;")) {
			bg = seq;
		}
	}
	return bg + fg;
}

/** Wrap ANSI-encoded string into rows of `w` visible chars. */
function wrapAnsi(s: string, w: number, maxRows = adaptiveWrapRows(), fillBg = ""): string[] {
	if (w <= 0) return [""];
	const plain = strip(s);
	if (plain.length <= w) {
		const pad = w - plain.length;
		return pad > 0 ? [s + fillBg + " ".repeat(pad) + (fillBg ? RST : "")] : [s];
	}

	const rows: string[] = [];
	let row = "";
	let vis = 0;
	let i = 0;
	let onLastRow = false;
	let effW = w;

	while (i < s.length) {
		if (!onLastRow && rows.length >= maxRows - 1) {
			onLastRow = true;
			effW = w > 2 ? w - 1 : w;
		}

		if (s[i] === "\x1b") {
			const end = s.indexOf("m", i);
			if (end !== -1) {
				row += s.slice(i, end + 1);
				i = end + 1;
				continue;
			}
		}

		if (vis >= effW) {
			if (onLastRow) {
				let hasMore = false;
				for (let j = i; j < s.length; j++) {
					if (s[j] === "\x1b") {
						const e2 = s.indexOf("m", j);
						if (e2 !== -1) {
							j = e2;
							continue;
						}
					}
					hasMore = true;
					break;
				}
				if (hasMore && w > 2) row += `${RST}${FG_DIM}›${RST}`;
				else row += fillBg + " ".repeat(Math.max(0, w - vis)) + RST;
				rows.push(row);
				return rows;
			}
			const state = ansiState(row);
			rows.push(row + RST);
			row = state + fillBg;
			vis = 0;
			if (rows.length >= maxRows - 1) {
				onLastRow = true;
				effW = w > 2 ? w - 1 : w;
			}
		}

		row += s[i];
		vis++;
		i++;
	}

	if (row.length > 0 || rows.length === 0) {
		rows.push(row + fillBg + " ".repeat(Math.max(0, w - vis)) + RST);
	}
	return rows;
}

/** Dense diagonal stripe fill for empty filler cells. */
function stripes(w: number, _rowOffset: number): string {
	return BG_BASE + FG_STRIPE + "╱".repeat(w) + RST;
}

/** Right-aligned line number. `noReset` keeps the active bg alive (no
 *  trailing RST) so the caller can build one bg-continuous gutter segment. */
function lnum(n: number | null, w: number, fg = FG_LNUM, noReset = false): string {
	if (n === null) return " ".repeat(w);
	const v = String(n);
	const pad = " ".repeat(Math.max(0, w - v.length));
	return noReset ? `${fg}${pad}${v}` : `${fg}${pad}${v}${RST}`;
}

/** Build one bg-continuous gutter row. A single `gutterBg` is set up front and
 *  only foreground colors switch inside it (fg changes never reset bg), so no
 *  internal RST can punch a dark gap. The trailing space adopts `bodyBg` to
 *  blend the gutter into the code body, then one RST closes the segment. */
function buildGutter(opts: {
	borderFg: string;
	gutterBg: string;
	bodyBg: string;
	num: number | null;
	numFg: string;
	signFg: string;
	sign: string;
	nw: number;
	continuation: boolean;
}): string {
	const { borderFg, gutterBg, bodyBg, num, numFg, signFg, sign, nw, continuation } = opts;
	const border = borderFg ? `${gutterBg}${borderFg}${BORDER_BAR}` : `${BG_BASE} `;
	const numCell = continuation
		? " ".repeat(nw + 2)
		: `${lnum(num, nw, numFg, true)}${signFg}${sign} `;
	return `${border}${gutterBg}${numCell}${FG_RULE}│${bodyBg} ${RST}`;
}

function rule(w: number): string {
	return `${BG_BASE}${FG_RULE}${"─".repeat(w)}${RST}`;
}

/** Compact plain "+a -d" summary for persisted renderer details. */
export function summarize(a: number, d: number): string {
	const parts: string[] = [];
	if (a > 0) parts.push(`+${a}`);
	if (d > 0) parts.push(`-${d}`);
	return parts.length ? parts.join(" ") : "no changes";
}

/** Apply active Pi theme colors to a plain diff summary at render time. */
export function renderDiffSummary(summary: string, theme: FgTheme): string {
	if (summary === "no changes") return theme.fg("toolDiffContext", summary);
	return summary
		.split(" ")
		.map((part) =>
			part.startsWith("+")
				? theme.fg("toolDiffAdded", part)
				: part.startsWith("-")
					? theme.fg("toolDiffRemoved", part)
					: part,
		)
		.join(" ");
}

// ---------------------------------------------------------------------------
// Word diff + bg injection
// ---------------------------------------------------------------------------

function wordDiffAnalysis(
	a: string,
	b: string,
): {
	similarity: number;
	oldRanges: Array<[number, number]>;
	newRanges: Array<[number, number]>;
} {
	if (!a && !b) return { similarity: 1, oldRanges: [], newRanges: [] };
	const parts = Diff.diffWords(a, b);
	const oldRanges: Array<[number, number]> = [];
	const newRanges: Array<[number, number]> = [];
	let oPos = 0;
	let nPos = 0;
	let same = 0;
	for (const p of parts) {
		if (p.removed) {
			oldRanges.push([oPos, oPos + p.value.length]);
			oPos += p.value.length;
		} else if (p.added) {
			newRanges.push([nPos, nPos + p.value.length]);
			nPos += p.value.length;
		} else {
			const len = p.value.length;
			same += len;
			oPos += len;
			nPos += len;
		}
	}
	const maxLen = Math.max(a.length, b.length);
	return {
		similarity: maxLen > 0 ? same / maxLen : 1,
		oldRanges,
		newRanges,
	};
}

/** Inject diff background into fg-only highlighted output.
 *  `baseBg` on unchanged spans, `hlBg` on changed char ranges.
 *  Re-injects bg after any reset-like sequence. */
function injectBg(
	ansiLine: string,
	ranges: Array<[number, number]>,
	baseBg: string,
	hlBg: string,
): string {
	if (!ranges.length) return baseBg + ansiLine + RST;

	let out = baseBg;
	let vis = 0;
	let inHL = false;
	let ri = 0;
	let i = 0;

	while (i < ansiLine.length) {
		if (ansiLine[i] === "\x1b") {
			const m = ansiLine.indexOf("m", i);
			if (m !== -1) {
				const seq = ansiLine.slice(i, m + 1);
				out += seq;
				if (seq === "\x1b[0m" || seq === "\x1b[39m" || seq === "\x1b[49m") {
					out += inHL ? hlBg : baseBg;
				}
				i = m + 1;
				continue;
			}
		}
		while (ri < ranges.length && vis >= (ranges[ri] as [number, number])[1]) ri++;
		const want =
			ri < ranges.length &&
			vis >= (ranges[ri] as [number, number])[0] &&
			vis < (ranges[ri] as [number, number])[1];
		if (want !== inHL) {
			inHL = want;
			out += inHL ? hlBg : baseBg;
		}
		out += ansiLine[i];
		vis++;
		i++;
	}
	return out + RST;
}

/** Simple word diff (no syntax hl) — fallback when highlighting is unavailable. */
function plainWordDiff(
	oldText: string,
	newText: string,
	dc: DiffColors,
): { old: string; new: string } {
	const parts = Diff.diffWords(oldText, newText);
	let o = "";
	let n = "";
	for (const p of parts) {
		if (p.removed) o += `${dc.bgDelHighlight}${p.value}${RST}${dc.bgDel}`;
		else if (p.added) n += `${dc.bgAddHighlight}${p.value}${RST}${dc.bgAdd}`;
		else {
			o += p.value;
			n += p.value;
		}
	}
	return { old: o, new: n };
}

/** Type-safe index into an array that noUncheckedIndexedAccess marks as T|undefined.
 *  Only call when the index is provably in-bounds (loop condition, length check, etc.). */
function at<T>(arr: T[], i: number): T {
	return arr[i] as T;
}

// ---------------------------------------------------------------------------
// Split-vs-unified decision
// ---------------------------------------------------------------------------

function shouldUseSplit(diff: ParsedDiff, tw: number, maxRows = MAX_PREVIEW_LINES): boolean {
	if (!diff.lines.length) return false;
	if (tw < SPLIT_MIN_WIDTH) return false;

	const nw = Math.max(
		2,
		String(Math.max(...diff.lines.map((l) => l.oldNum ?? l.newNum ?? 0), 0)).length,
	);
	const half = Math.floor((tw - 1) / 2);
	const gw = nw + 5;
	const cw = Math.max(12, half - gw);
	if (cw < SPLIT_MIN_CODE_WIDTH) return false;

	const vis = diff.lines.slice(0, maxRows);
	let contentLines = 0;
	let wrapCandidates = 0;
	for (const l of vis) {
		if (l.type === "sep") continue;
		contentLines++;
		if (tabs(l.content).length > cw) wrapCandidates++;
	}
	if (contentLines === 0) return true;

	const wrapRatio = wrapCandidates / contentLines;
	if (wrapCandidates >= SPLIT_MAX_WRAP_LINES) return false;
	if (wrapRatio >= SPLIT_MAX_WRAP_RATIO) return false;
	return true;
}

// ---------------------------------------------------------------------------
// Unified (stacked) view
// ---------------------------------------------------------------------------

export async function renderUnified(
	diff: ParsedDiff,
	language: BundledLanguage | undefined,
	max = MAX_RENDER_LINES,
	dc: DiffColors = DEFAULT_DIFF_COLORS,
): Promise<string> {
	if (!diff.lines.length) return "";

	const vis = diff.lines.slice(0, max);
	const tw = termW();
	const nw = Math.max(2, String(Math.max(...vis.map((l) => l.oldNum ?? l.newNum ?? 0), 0)).length);
	const gw = nw + 5;
	const cw = Math.max(20, tw - gw);
	const canHL = diff.chars <= MAX_HL_CHARS && vis.length <= MAX_RENDER_LINES;

	const oldSrc: string[] = [];
	const newSrc: string[] = [];
	for (const l of vis) {
		if (l.type === "ctx" || l.type === "del") oldSrc.push(l.content);
		if (l.type === "ctx" || l.type === "add") newSrc.push(l.content);
	}
	const [oldHL, newHL] = canHL
		? await Promise.all([
				hlBlock(oldSrc.join("\n"), language, dc.theme),
				hlBlock(newSrc.join("\n"), language, dc.theme),
			])
		: [oldSrc, newSrc];

	let oI = 0;
	let nI = 0;
	let idx = 0;
	const out: string[] = [];
	out.push(rule(tw));

	function emitRow(
		num: number | null,
		sign: string,
		gutterBg: string,
		signFg: string,
		body: string,
		bodyBg = "",
	): void {
		const borderFg = sign === "-" ? dc.fgDel : sign === "+" ? dc.fgAdd : "";
		const numFg = borderFg || FG_LNUM;
		const gutterArgs = {
			borderFg,
			gutterBg,
			bodyBg,
			num,
			numFg,
			signFg,
			sign,
			nw,
		};
		const gutter = buildGutter({ ...gutterArgs, continuation: false });
		const contGutter = buildGutter({ ...gutterArgs, continuation: true });
		const rows = wrapAnsi(tabs(body), cw, adaptiveWrapRows(), bodyBg);
		out.push(`${gutter}${rows[0]}${RST}`);
		for (let r = 1; r < rows.length; r++) out.push(`${contGutter}${rows[r]}${RST}`);
	}

	while (idx < vis.length) {
		const l = at(vis, idx);

		if (l.type === "sep") {
			const gap = l.newNum;
			const label = gap && gap > 0 ? ` ${gap} unmodified lines ` : "···";
			const totalW = Math.min(tw, 72);
			const pad = Math.max(0, totalW - label.length - 2);
			const half1 = Math.floor(pad / 2);
			const half2 = pad - half1;
			out.push(`${BG_BASE}${FG_DIM}${"─".repeat(half1)}${label}${"─".repeat(half2)}${RST}`);
			idx++;
			continue;
		}

		if (l.type === "ctx") {
			const hl = oldHL[oI] ?? l.content;
			emitRow(l.newNum, " ", BG_BASE, dc.fgCtx, `${BG_BASE}${DIM}${hl}`, BG_BASE);
			oI++;
			nI++;
			idx++;
			continue;
		}

		const dels: Array<{ l: DiffLine; hl: string }> = [];
		while (idx < vis.length) {
			const entry = at(vis, idx);
			if (entry.type !== "del") break;
			dels.push({ l: entry, hl: oldHL[oI] ?? entry.content });
			oI++;
			idx++;
		}
		const adds: Array<{ l: DiffLine; hl: string }> = [];
		while (idx < vis.length) {
			const entry = at(vis, idx);
			if (entry.type !== "add") break;
			adds.push({ l: entry, hl: newHL[nI] ?? entry.content });
			nI++;
			idx++;
		}

		const isPaired = dels.length === 1 && adds.length === 1;
		const wd = isPaired ? wordDiffAnalysis(at(dels, 0).l.content, at(adds, 0).l.content) : null;
		const wdBalanced = wd && wd.oldRanges.length > 0 && wd.newRanges.length > 0;

		if (isPaired && wdBalanced && wd.similarity >= WORD_DIFF_MIN_SIM && canHL) {
			const del0 = at(dels, 0);
			const add0 = at(adds, 0);
			const delBody = injectBg(del0.hl, wd.oldRanges, dc.bgDel, dc.bgDelHighlight);
			const addBody = injectBg(add0.hl, wd.newRanges, dc.bgAdd, dc.bgAddHighlight);
			emitRow(del0.l.oldNum, "-", dc.bgGutterDel, `${dc.fgDel}${BOLD}`, delBody, dc.bgDel);
			emitRow(add0.l.newNum, "+", dc.bgGutterAdd, `${dc.fgAdd}${BOLD}`, addBody, dc.bgAdd);
			continue;
		}
		if (isPaired && wdBalanced && wd.similarity >= WORD_DIFF_MIN_SIM && !canHL) {
			const del0 = at(dels, 0);
			const add0 = at(adds, 0);
			const pwd = plainWordDiff(del0.l.content, add0.l.content, dc);
			emitRow(
				del0.l.oldNum,
				"-",
				dc.bgGutterDel,
				`${dc.fgDel}${BOLD}`,
				`${dc.bgDel}${pwd.old}`,
				dc.bgDel,
			);
			emitRow(
				add0.l.newNum,
				"+",
				dc.bgGutterAdd,
				`${dc.fgAdd}${BOLD}`,
				`${dc.bgAdd}${pwd.new}`,
				dc.bgAdd,
			);
			continue;
		}

		for (const d of dels) {
			const body = canHL ? `${dc.bgDel}${d.hl}` : `${dc.bgDel}${d.l.content}`;
			emitRow(d.l.oldNum, "-", dc.bgGutterDel, `${dc.fgDel}${BOLD}`, body, dc.bgDel);
		}
		for (const a of adds) {
			const body = canHL ? `${dc.bgAdd}${a.hl}` : `${dc.bgAdd}${a.l.content}`;
			emitRow(a.l.newNum, "+", dc.bgGutterAdd, `${dc.fgAdd}${BOLD}`, body, dc.bgAdd);
		}
	}

	out.push(rule(tw));
	if (diff.lines.length > vis.length) {
		out.push(`${BG_BASE}${FG_DIM}  … ${diff.lines.length - vis.length} more lines${RST}`);
	}
	return out.join("\n");
}

// ---------------------------------------------------------------------------
// Split view (auto-fallback to unified when narrow)
// ---------------------------------------------------------------------------

export async function renderSplit(
	diff: ParsedDiff,
	language: BundledLanguage | undefined,
	max = MAX_PREVIEW_LINES,
	dc: DiffColors = DEFAULT_DIFF_COLORS,
): Promise<string> {
	const tw = termW();
	if (!shouldUseSplit(diff, tw, max)) return renderUnified(diff, language, max, dc);
	if (!diff.lines.length) return "";

	type Row = { left: DiffLine | null; right: DiffLine | null };
	const rows: Row[] = [];
	let i = 0;
	while (i < diff.lines.length) {
		const l = at(diff.lines, i);
		if (l.type === "sep" || l.type === "ctx") {
			rows.push({ left: l, right: l });
			i++;
			continue;
		}
		const dels: DiffLine[] = [];
		const adds: DiffLine[] = [];
		while (i < diff.lines.length) {
			const entry = at(diff.lines, i);
			if (entry.type !== "del") break;
			dels.push(entry);
			i++;
		}
		while (i < diff.lines.length) {
			const entry = at(diff.lines, i);
			if (entry.type !== "add") break;
			adds.push(entry);
			i++;
		}
		const n = Math.max(dels.length, adds.length);
		for (let j = 0; j < n; j++) rows.push({ left: dels[j] ?? null, right: adds[j] ?? null });
	}

	const vis = rows.slice(0, max);
	const half = Math.floor((tw - 1) / 2);
	const nw = Math.max(
		2,
		String(Math.max(...diff.lines.map((l) => l.oldNum ?? l.newNum ?? 0), 0)).length,
	);
	const gw = nw + 5;
	const cw = Math.max(12, half - gw);
	const canHL = diff.chars <= MAX_HL_CHARS && vis.length * 2 <= MAX_RENDER_LINES * 2;

	const leftSrc: string[] = [];
	const rightSrc: string[] = [];
	for (const r of vis) {
		if (r.left && r.left.type !== "sep") leftSrc.push(r.left.content);
		if (r.right && r.right.type !== "sep") rightSrc.push(r.right.content);
	}
	const [leftHL, rightHL] = canHL
		? await Promise.all([
				hlBlock(leftSrc.join("\n"), language, dc.theme),
				hlBlock(rightSrc.join("\n"), language, dc.theme),
			])
		: [leftSrc, rightSrc];

	let lI = 0;
	let rI = 0;
	let stripeRow = 0;

	type HalfResult = { gutter: string; contGutter: string; bodyRows: string[] };

	function halfBuild(
		line: DiffLine | null,
		hl: string,
		ranges: Array<[number, number]> | null,
		side: "left" | "right",
	): HalfResult {
		if (!line) {
			const gw2 = nw + 2;
			const gPat = FG_STRIPE + "╱".repeat(gw2) + RST;
			const g = ` ${gPat}${FG_RULE}│${RST} `;
			return { gutter: g, contGutter: g, bodyRows: [stripes(cw, stripeRow)] };
		}
		if (line.type === "sep") {
			const gap = line.newNum;
			const label = gap && gap > 0 ? `··· ${gap} lines ···` : "···";
			const g = `${BG_BASE} ${FG_DIM}${fit("", nw + 2)}${RST}${FG_RULE}│${RST} `;
			return {
				gutter: g,
				contGutter: g,
				bodyRows: [`${BG_BASE}${FG_DIM}${fit(label, cw)}${RST}`],
			};
		}

		const isDel = line.type === "del";
		const isAdd = line.type === "add";
		const gBg = isDel ? dc.bgGutterDel : isAdd ? dc.bgGutterAdd : BG_BASE;
		const cBg = isDel ? dc.bgDel : isAdd ? dc.bgAdd : BG_BASE;
		const sFg = isDel ? dc.fgDel : isAdd ? dc.fgAdd : dc.fgCtx;
		const sign = isDel ? "-" : isAdd ? "+" : " ";
		const num = isDel
			? line.oldNum
			: isAdd
				? line.newNum
				: side === "left"
					? line.oldNum
					: line.newNum;

		const borderFg = isDel ? dc.fgDel : isAdd ? dc.fgAdd : "";
		const numFg = borderFg || FG_LNUM;

		let body: string;
		if (ranges && ranges.length > 0) {
			body = injectBg(hl, ranges, cBg, isDel ? dc.bgDelHighlight : dc.bgAddHighlight);
		} else if (isDel || isAdd) {
			body = `${cBg}${hl}`;
		} else {
			body = `${BG_BASE}${DIM}${hl}`;
		}

		// Split view's non-bordered context rows lead with a space before bg;
		// buildGutter handles bordered rows, so feed the same border convention.
		const splitBorder = borderFg ? `${gBg}${borderFg}${BORDER_BAR}` : ` ${BG_BASE}`;
		const numCell = `${lnum(num, nw, numFg, true)}${sFg}${BOLD}${sign} `;
		const gutter = `${splitBorder}${gBg}${numCell}${FG_RULE}│${cBg} ${RST}`;
		const contGutter = `${splitBorder}${gBg}${" ".repeat(nw + 2)}${FG_RULE}│${cBg} ${RST}`;
		const bodyRows = wrapAnsi(tabs(body), cw, adaptiveWrapRows(), cBg);
		return { gutter, contGutter, bodyRows };
	}

	const out: string[] = [];
	out.push(`${rule(half)}${FG_RULE}┊${RST}${rule(half)}`);

	for (const r of vis) {
		const leftLine = r.left;
		const rightLine = r.right;
		const paired = leftLine && rightLine && leftLine.type === "del" && rightLine.type === "add";
		const wd = paired ? wordDiffAnalysis(leftLine.content, rightLine.content) : null;

		let lResult: HalfResult;
		let rResult: HalfResult;

		if (paired && wd && wd.similarity >= WORD_DIFF_MIN_SIM && canHL) {
			const lhl = leftHL[lI++] ?? leftLine.content;
			const rhl = rightHL[rI++] ?? rightLine.content;
			lResult = halfBuild(leftLine, lhl, wd.oldRanges, "left");
			rResult = halfBuild(rightLine, rhl, wd.newRanges, "right");
		} else if (paired && wd && wd.similarity >= WORD_DIFF_MIN_SIM && !canHL) {
			const pwd = plainWordDiff(leftLine.content, rightLine.content, dc);
			lI++;
			rI++;
			lResult = halfBuild(leftLine, pwd.old, null, "left");
			rResult = halfBuild(rightLine, pwd.new, null, "right");
		} else {
			const lhl =
				leftLine && leftLine.type !== "sep" ? (leftHL[lI++] ?? leftLine?.content ?? "") : "";
			const rhl =
				rightLine && rightLine.type !== "sep" ? (rightHL[rI++] ?? rightLine?.content ?? "") : "";
			lResult = halfBuild(leftLine, lhl, null, "left");
			rResult = halfBuild(rightLine, rhl, null, "right");
		}

		const maxRowsN = Math.max(lResult.bodyRows.length, rResult.bodyRows.length);
		for (let row = 0; row < maxRowsN; row++) {
			const lg = row === 0 ? lResult.gutter : lResult.contGutter;
			const rg = row === 0 ? rResult.gutter : rResult.contGutter;
			// A missing body row means this side has no content at this visual row
			// (other side wrapped longer, or the side is empty) — always hatch it.
			const lb = lResult.bodyRows[row] ?? stripes(cw, stripeRow);
			const rb = rResult.bodyRows[row] ?? stripes(cw, stripeRow);
			out.push(`${lg}${lb}${DIVIDER}${rg}${rb}${RST}`);
			stripeRow++;
		}
	}

	out.push(`${rule(half)}${FG_RULE}┊${RST}${rule(half)}`);
	if (rows.length > vis.length) {
		out.push(`${BG_BASE}${FG_DIM}  … ${rows.length - vis.length} more lines${RST}`);
	}
	return out.join("\n");
}
