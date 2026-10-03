import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { config } from "@xynogen/pix-runtime/config";
import { prettySection } from "@xynogen/pix-runtime/sections";

import { FG_DIM, FG_LNUM, FG_RULE, RST } from "./ansi.ts";
import { MAX_PREVIEW_LINES } from "./config.ts";
import { hlBlock } from "./highlight.ts";
import { dirIcon, fileColor, fileIcon } from "./icons.ts";
import { lang } from "./lang.ts";
import type { FgTheme } from "./types.ts";
import { BODY_PAD, lnum, normalizeLineEndings, pluralize, rule, termW } from "./utils.ts";

/** Layout controls for {@link renderFileContent}. */
export interface RenderFileContentOptions {
	/** Total render width. Defaults to the live terminal width (`termW()`). */
	width?: number;
	/**
	 * Wrap over-wide code lines onto continuation rows instead of clipping the
	 * tail with `›`. Off by default (compact preview stays one row per line);
	 * expanded views pass `true` so no source text is hidden.
	 */
	wrapLongLines?: boolean;
}

/** Render syntax-highlighted file content with line numbers. */
export async function renderFileContent(
	content: string,
	filePath: string,
	offset = 1,
	maxLines = MAX_PREVIEW_LINES,
	theme?: FgTheme,
	options: RenderFileContentOptions = {},
): Promise<string> {
	const normalizedContent = normalizeLineEndings(content);
	const lines = normalizedContent.split("\n");
	const total = lines.length;
	const show = lines.slice(0, maxLines);
	const lg = lang(filePath);
	const hl = await hlBlock(show.join("\n"), lg, theme);

	const tw = options.width ?? termW();
	const startLine = offset;
	const endLine = startLine + show.length - 1;
	const nw = Math.max(3, String(endLine).length);
	const gw = nw + 3; // num + " │ "
	const cw = Math.max(1, tw - gw);

	const out: string[] = [];
	out.push(rule(tw));

	for (let i = 0; i < hl.length; i++) {
		const ln = startLine + i;
		const code = hl[i] ?? show[i] ?? "";
		if (options.wrapLongLines && visibleWidth(code) > cw) {
			// Expanded view: no tail is hidden. First row carries the line number,
			// continuation rows indent under the gutter so the code column aligns.
			const rows = wrapTextWithAnsi(code, cw);
			const pad = " ".repeat(nw);
			rows.forEach((rowText, r) => {
				const gutter = r === 0 ? lnum(ln, nw) : `${FG_LNUM}${pad}${RST}`;
				out.push(`${gutter} ${FG_RULE}│${RST} ${rowText}${RST}`);
			});
			continue;
		}
		const display = truncateToWidth(code, cw, `${FG_DIM}›`);
		out.push(`${lnum(ln, nw)} ${FG_RULE}│${RST} ${display}${RST}`);
	}

	out.push(rule(tw));
	if (total > maxLines) {
		out.push(
			`${FG_DIM}${BODY_PAD}… ${pluralize(total - maxLines, "more line")} (${total} total)${RST}`,
		);
	}
	return out.join("\n");
}

/** Render bash output with colored exit code and stderr highlighting. */
export function renderBashOutput(
	text: string,
	exitCode: number | null,
	theme?: FgTheme,
): { summary: string; body: string } {
	const isOk = exitCode === 0;
	const statusIcon = isOk ? "✓" : "✗";
	const semantic = isOk ? "success" : "error";
	const codeText = exitCode !== null ? `${statusIcon} exit ${exitCode}` : "⚡ killed";
	const codeStr = theme ? theme.fg(exitCode !== null ? semantic : "warning", codeText) : codeText;

	const lines = text.split("\n");
	const maxShow = MAX_PREVIEW_LINES;
	const show = lines.slice(0, maxShow);
	const remaining = lines.length - maxShow;

	let body = show.join("\n");
	if (remaining > 0) {
		body += `\n${FG_DIM}  … ${pluralize(remaining, "more line")}${RST}`;
	}

	return { summary: codeStr, body };
}

/** Render ls output using the configured style (grid or tree). */
export function renderTree(text: string, basePath: string, theme?: FgTheme): string {
	return config(prettySection).lsStyle === "tree"
		? renderLsTree(text, basePath, theme)
		: renderLsGrid(text, basePath, theme);
}

/** Vertical tree view with connectors and icons. */
/** Color a listing entry: dirs use the theme accent, files use their
 *  per-extension hue (fileColor). Pure passthrough without a theme. */
function entryColor(isDir: boolean, name: string, theme?: FgTheme): string {
	if (!theme) return name;
	return isDir ? theme.fg("accent", name) : fileColor(name, name, theme);
}

function renderLsTree(text: string, _basePath: string, theme?: FgTheme): string {
	const lines = text.trim().split("\n").filter(Boolean);
	if (!lines.length) return `${FG_DIM}(empty directory)${RST}`;

	const out: string[] = [];
	const total = lines.length;
	const show = lines.slice(0, MAX_PREVIEW_LINES);

	for (let i = 0; i < show.length; i++) {
		const entry = (show[i] ?? "").trim();
		const isLast = i === show.length - 1 && total <= MAX_PREVIEW_LINES;
		const prefix = isLast ? "└── " : "├── ";
		const connector = `${FG_RULE}${prefix}${RST}`;

		const isDir = entry.endsWith("/");
		const name = isDir ? entry.slice(0, -1) : entry;
		const icon = isDir ? dirIcon(theme) : fileIcon(name, theme);
		const displayName = entryColor(isDir, name, theme);

		out.push(`${connector}${icon}${displayName}`);
	}

	if (total > MAX_PREVIEW_LINES) {
		out.push(
			`${FG_RULE}└── ${RST}${FG_DIM}… ${pluralize(total - MAX_PREVIEW_LINES, "more entry", "more entries")}${RST}`,
		);
	}

	return out.join("\n");
}

/** Horizontal grid with icons (like eza/ls). */
function renderLsGrid(text: string, _basePath: string, theme?: FgTheme): string {
	const lines = text.trim().split("\n").filter(Boolean);
	if (!lines.length) return `${FG_DIM}(empty directory)${RST}`;

	const total = lines.length;
	const show = lines.slice(0, MAX_PREVIEW_LINES);

	// Build styled cells + measure their visible widths
	const cells: string[] = [];
	const cellWidths: number[] = [];

	for (const raw of show) {
		const entry = raw.trim();
		const isDir = entry.endsWith("/");
		const name = isDir ? entry.slice(0, -1) : entry;
		const icon = isDir ? dirIcon(theme) : fileIcon(name, theme);
		const displayName = entryColor(isDir, name, theme);
		const cell = `${icon}${displayName}`;
		cells.push(cell);
		cellWidths.push(visibleWidth(cell));
	}

	// Layout into columns that fit the terminal width
	const tw = termW();
	const GAP = 3; // spaces between columns
	const rows = layoutGrid(cells, cellWidths, tw, GAP);

	if (total > MAX_PREVIEW_LINES) {
		rows.push(
			`${FG_DIM}… ${pluralize(total - MAX_PREVIEW_LINES, "more entry", "more entries")}${RST}`,
		);
	}

	return rows.join("\n");
}

/**
 * Lay out styled cells into a grid that fills rows left-to-right,
 * using as many columns as fit within `maxWidth`.
 */
function layoutGrid(cells: string[], widths: number[], maxWidth: number, gap: number): string[] {
	const n = cells.length;
	if (n === 0) return [];

	// Try increasing column counts to find the maximum that fits
	let bestCols = 1;
	for (let cols = 2; cols <= n; cols++) {
		const numRows = Math.ceil(n / cols);
		let totalW = 0;
		let fits = true;
		for (let c = 0; c < cols; c++) {
			// Find max width in this column
			let colW = 0;
			for (let r = 0; r < numRows; r++) {
				const idx = r * cols + c;
				if (idx < n && (widths[idx] ?? 0) > colW) colW = widths[idx] ?? 0;
			}
			totalW += colW + (c < cols - 1 ? gap : 0);
			if (totalW > maxWidth) {
				fits = false;
				break;
			}
		}
		if (fits) bestCols = cols;
		else break;
	}

	const cols = bestCols;
	const numRows = Math.ceil(n / cols);

	// Compute column widths
	const colWidths: number[] = [];
	for (let c = 0; c < cols; c++) {
		let colW = 0;
		for (let r = 0; r < numRows; r++) {
			const idx = r * cols + c;
			if (idx < n && (widths[idx] ?? 0) > colW) colW = widths[idx] ?? 0;
		}
		colWidths.push(colW);
	}

	// Render rows
	const out: string[] = [];
	for (let r = 0; r < numRows; r++) {
		const parts: string[] = [];
		for (let c = 0; c < cols; c++) {
			const idx = r * cols + c;
			if (idx >= n) break;
			const cell = cells[idx] ?? "";
			const w = widths[idx] ?? 0;
			const target = colWidths[c] ?? 0;
			// Pad to column width, except for the last column in a row
			const pad = c < cols - 1 ? " ".repeat(Math.max(0, target - w + gap)) : "";
			parts.push(cell + pad);
		}
		out.push(parts.join(""));
	}

	return out;
}

// ---------------------------------------------------------------------------
// FFF integration (optional) — Fast File Finder with frecency & SIMD search
//
// If @ff-labs/fff-node is installed, find/grep use FFF for speed + frecency.
// If not, falls back to wrapping SDK tools (current behavior).
// ---------------------------------------------------------------------------
