/**
 * Directives in assistant Markdown (generic-directive syntax, as in Codex):
 *
 *   ::stat[23]{label="Total entri"}   leaf: consecutive lines render as one row of cards
 *   ::bar[120]{label="pix-core"}   leaf: consecutive lines render as one bar chart
 *   ::chart[3 5 4 8]{label="Build (s)" height=8}   leaf: braille line chart
 *   :red[text]  :green[text]  :yellow[text]  :blue[text]   inline: colored emphasis
 *   :spark[1 4 2 8 5]   inline: sparkline ▁▃▂▇▅
 *
 * Display only: the session and the model keep the raw text. Code fences and
 * inline code stay literal.
 */
import { BOLD, FG_BLUE, FG_DIM, FG_GREEN, FG_RED, FG_YELLOW, RST } from "@xynogen/pix-pretty/ansi";
import { truncateToWidth, visibleWidth } from "@xynogen/pix-pretty/tui";
import type { ExtensionAPI } from "@xynogen/pix-runtime/host";

const STAT = /^::stat\[([^\]\n]*)\](?:\{([^}\n]*)\})?\s*$/;
const CHART = /^::chart\[([^\]\n]+)\](?:\{([^}\n]*)\})?\s*$/;
const BAR = /^::bar\[([^\]\n]+)\](?:\{([^}\n]*)\})?\s*$/;
// Left-aligned partial blocks, 1/8 to 7/8 of a cell.
const PARTIAL = " ▏▎▍▌▋▊▉";
const MAX_BAR_LABEL = 20;
const ATTR = /(\w+)=(?:"((?:[^"\\]|\\.)*)"|([^\s"}]+))/g;
const FENCE = /^\s*(```|~~~)/;
const MIN_CARD = 16;
const MAX_CHART = 72;
// Braille dot bit for (row, column) inside one 2×4 cell.
const DOT = [
	[0x01, 0x08],
	[0x02, 0x10],
	[0x04, 0x20],
	[0x40, 0x80],
];
// NBSP pads the axis gutter: Markdown would strip or code-block leading spaces.
const NBSP = "\u00a0";
const COLORS: Record<string, string> = {
	red: FG_RED,
	green: FG_GREEN,
	yellow: FG_YELLOW,
	blue: FG_BLUE,
};
const SPARK = "▁▂▃▄▅▆▇█";
const MAX_SPARK = 60;
// A code span is matched first and kept, so `:red[x]` inside backticks stays literal.
const INLINE = /(`+)[^`]*?\1|(?<![\w:]):(red|green|yellow|blue|spark)\[([^\]\n]+)\]/g;

/** Sparkline for 2..MAX_SPARK finite numbers; undefined leaves the directive as text. */
export function sparkline(raw: string): string | undefined {
	const values = raw
		.split(/[\s,]+/)
		.filter(Boolean)
		.map(Number);
	if (values.length < 2 || values.length > MAX_SPARK) return undefined;
	if (values.some((v) => !Number.isFinite(v))) return undefined;
	const min = Math.min(...values);
	const span = Math.max(...values) - min;
	const last = SPARK.length - 1;
	return values
		.map((v) => SPARK[span === 0 ? last >> 1 : Math.round(((v - min) / span) * last)])
		.join("");
}

/** Inline directives. `\x1b[39m` resets only the color, so bold or italic around it survives. */
export function colorInline(line: string): string {
	return line.replace(INLINE, (match, _ticks, name?: string, text = "") => {
		if (!name) return match;
		if (name !== "spark") return `${COLORS[name]}${text}\x1b[39m`;
		const spark = sparkline(text);
		return spark ? `${FG_BLUE}${spark}\x1b[39m` : match;
	});
}

type Stat = { value: string; label: string; color: string };

function attrs(raw: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [, key, quoted, bare] of (raw ?? "").matchAll(ATTR)) {
		if (key) out[key] = quoted?.replace(/\\(.)/g, "$1") ?? bare ?? "";
	}
	return out;
}

/** `color=red|green|yellow|blue`; anything else keeps the default accent. */
function colorOf(name: string | undefined): string {
	return (name && COLORS[name]) || FG_BLUE;
}

function parseStat(line: string): Stat | undefined {
	const match = STAT.exec(line);
	if (!match) return undefined;
	const { label = "", color } = attrs(match[2]);
	return { value: match[1] ?? "", label, color: colorOf(color) };
}

type Chart = { values: number[]; label: string; height: number; color: string };

function parseChart(line: string): Chart | undefined {
	const match = CHART.exec(line);
	if (!match) return undefined;
	const values = (match[1] ?? "")
		.split(/[\s,]+/)
		.filter(Boolean)
		.map(Number);
	if (values.length < 2 || values.some((v) => !Number.isFinite(v))) return undefined;
	const { label = "", height, color } = attrs(match[2]);
	return {
		values,
		label,
		height: Math.min(20, Math.max(3, Number(height) || 8)),
		color: colorOf(color),
	};
}

function axisNumber(n: number): string {
	return String(Number(n.toPrecision(4)));
}

/** Braille line chart: y axis with max/min labels, one plotted series. */
export function renderChart({ values, label, height, color }: Chart, width: number): string[] {
	const max = Math.max(...values);
	const min = Math.min(...values);
	const top = axisNumber(max);
	const bottom = axisNumber(min);
	const gutter = Math.max(top.length, bottom.length);
	const cols = Math.max(2, Math.min(width, MAX_CHART) - gutter - 1);
	const dotsX = cols * 2 - 1;
	const dotsY = height * 4 - 1;
	const grid = Array.from({ length: height }, () => new Array<number>(cols).fill(0));
	const x = (i: number) => (i * dotsX) / (values.length - 1);
	const y = (v: number) => (max === min ? 0.5 : (max - v) / (max - min)) * dotsY;
	const plot = (px: number, py: number) => {
		const row = grid[py >> 2];
		if (row) row[px >> 1] = (row[px >> 1] ?? 0) | (DOT[py & 3]?.[px & 1] ?? 0);
	};
	for (let i = 1; i < values.length; i++) {
		const [x0, y0, x1, y1] = [x(i - 1), y(values[i - 1] ?? 0), x(i), y(values[i] ?? 0)];
		const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
		for (let s = 0; s <= steps; s++) {
			plot(Math.round(x0 + ((x1 - x0) * s) / steps), Math.round(y0 + ((y1 - y0) * s) / steps));
		}
	}
	const pad = (text: string) => literal(NBSP.repeat(gutter - text.length) + text);
	const rows = label ? [`${BOLD}${literal(label)}${RST}`] : [];
	grid.forEach((cells, r) => {
		const tick = r === 0 ? top : r === height - 1 ? bottom : "";
		const axis = `${FG_DIM}${pad(tick)}${tick ? "┤" : "│"}${RST}`;
		rows.push(`${axis}${color}${String.fromCharCode(...cells.map((b) => 0x2800 + b))}${RST}`);
	});
	rows.push(`${FG_DIM}${pad("")}└${"─".repeat(cols)}${RST}`);
	return rows;
}

type Bar = { value: number; label: string; color: string };

function parseBar(line: string): Bar | undefined {
	const match = BAR.exec(line);
	const value = Number(match?.[1]);
	if (!match || !Number.isFinite(value)) return undefined;
	const { label = "", color } = attrs(match[2]);
	return { value, label, color: colorOf(color) };
}

/** Horizontal bar chart: label column, bar scaled to the largest value, value text. */
export function renderBars(bars: readonly Bar[], width: number): string[] {
	const max = Math.max(...bars.map((b) => b.value), 0);
	const labels = bars.map((b) => truncateToWidth(b.label, MAX_BAR_LABEL, "…"));
	const labelWidth = Math.max(...labels.map((l) => visibleWidth(l)));
	const numbers = bars.map((b) => axisNumber(b.value));
	const barWidth = Math.max(
		1,
		Math.min(width, MAX_CHART) - labelWidth - Math.max(...numbers.map((n) => n.length)) - 2,
	);
	return bars.map((bar, i) => {
		const eighths = max > 0 ? Math.round((Math.max(0, bar.value) / max) * barWidth * 8) : 0;
		const fill = "█".repeat(eighths >> 3) + (PARTIAL[eighths & 7] ?? "").trim();
		const label = labels[i] ?? "";
		const gap = NBSP.repeat(labelWidth - visibleWidth(label) + 1);
		return `${literal(label)}${gap}${bar.color}${fill}${RST} ${FG_DIM}${literal(numbers[i] ?? "")}${RST}`;
	});
}

/**
 * Backslash-escape Markdown punctuation so the text keeps its characters and width.
 * Brackets and parens stay bare: Pi reads `\(`…`\)` and `\[`…`\]` as LaTeX delimiters.
 */
function literal(text: string): string {
	return text.replace(/[!-'*-/:-@\\^_`{-~]/g, "\\$&");
}

function cell(text: string, width: number, style: string): string {
	const fitted = truncateToWidth(text, width, "…");
	const pad = " ".repeat(Math.max(0, width - visibleWidth(fitted)));
	return `${FG_DIM}│${RST} ${style}${literal(fitted)}${RST}${pad} ${FG_DIM}│${RST}`;
}

/** Box rows for the stats, wrapped so no row exceeds `width` columns. */
export function renderStatRow(stats: readonly Stat[], width: number): string[] {
	const perRow = Math.max(1, Math.min(stats.length, Math.floor((width + 1) / (MIN_CARD + 1))));
	const card = Math.floor((width + 1) / perRow) - 1;
	const inner = card - 4;
	const rule = "─".repeat(card - 2);
	const rows: string[] = [];
	for (let i = 0; i < stats.length; i += perRow) {
		const group = stats.slice(i, i + perRow);
		const join = (parts: string[]) => parts.join(" ");
		rows.push(join(group.map(() => `${FG_DIM}╭${rule}╮${RST}`)));
		// Accent value over a default-color label: dim text on a dim frame read as flat.
		rows.push(join(group.map((s) => cell(s.value, inner, `${BOLD}${s.color}`))));
		rows.push(join(group.map((s) => cell(s.label, inner, ""))));
		rows.push(join(group.map(() => `${FG_DIM}╰${rule}╯${RST}`)));
	}
	return rows;
}

export function renderDirectives(markdown: string, width: number): string {
	if (!/::(?:stat|chart|bar)\[|:(?:red|green|yellow|blue|spark)\[/.test(markdown)) return markdown;
	const out: string[] = [];
	let fenced = false;
	let stats: Stat[] = [];
	let bars: Bar[] = [];
	// Blank lines keep each block a paragraph of its own.
	const flush = () => {
		if (stats.length > 0) out.push("", ...renderStatRow(stats, width), "");
		if (bars.length > 0) out.push("", ...renderBars(bars, width), "");
		stats = [];
		bars = [];
	};
	for (const line of markdown.split("\n")) {
		if (FENCE.test(line)) fenced = !fenced;
		const stat = fenced || width < MIN_CARD ? undefined : parseStat(line);
		if (stat) {
			if (bars.length > 0) flush();
			stats.push(stat);
			continue;
		}
		const bar = fenced || width < MIN_CARD ? undefined : parseBar(line);
		if (bar) {
			if (stats.length > 0) flush();
			bars.push(bar);
			continue;
		}
		const chart = fenced || width < MIN_CARD ? undefined : parseChart(line);
		if (chart) {
			flush();
			out.push("", ...renderChart(chart, width), "");
			continue;
		}
		flush();
		out.push(fenced ? line : colorInline(line));
	}
	flush();
	return out.join("\n");
}

export default function directivesExtension(pi: ExtensionAPI): void {
	pi.registerMarkdownTransformer?.(
		(markdown, { availableWidth }) => renderDirectives(markdown, availableWidth),
		{ messageTypes: ["assistant"] },
	);
}
