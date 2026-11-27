/**
 * Directives in assistant Markdown (generic-directive syntax, as in Codex):
 *
 *   ::card[23]{label="Total entri"}   leaf: consecutive value cards render side by side;
 *     a subtitle= or body lines (up to a blank line) make it a full-width card
 *   ::bar[120]{label="pix-core"}   leaf: consecutive lines render as one bar chart
 *   ::stacked[40]{label="pix-core"}   leaf: consecutive lines render as one stacked 100% bar with a legend
 *   :red[text]  :green[text]  :yellow[text]  :blue[text]   inline: colored emphasis
 *   :spark[1 4 2 8 5]   inline: sparkline ▁▃▂▇▅
 *   :badge[Tahap 1]{color=green}   inline: label on a tinted background
 *
 * Display only: the session and the model keep the raw text. Code fences and
 * inline code stay literal.
 */
import { BOLD, FG_BLUE, FG_DIM, FG_GREEN, FG_RED, FG_YELLOW, RST } from "@xynogen/pix-pretty/ansi";
import { setMarkdownTransform } from "@xynogen/pix-pretty/markdown-transform";
import {
	getCapabilities,
	getMarkdownTheme,
	Markdown,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@xynogen/pix-pretty/tui";
import type { ExtensionAPI } from "@xynogen/pix-runtime/host";
import { foldsOpen, renderFolds } from "./fold.ts";
import { parseImage, renderImage } from "./image.ts";
import { renderMathBlocks } from "./math.ts";
import { renderMermaidBlocks } from "./mermaid.ts";

const BAR = /^::bar\[([^\]\n]+)\](?:\{([^}\n]*)\})?\s*$/;
// The lines right after a card, up to a blank line, are its Markdown body.
const CARD = /^::card(?:\[([^\]\n]*)\])?(?:\{([^}\n]*)\})?\s*$/;
const ITALIC = "\x1b[3m";
// SGR and OSC 8 sequences in already-rendered text: kept as is, only the text between is escaped.
const ESCAPE_SEQ = /(\x1b\[[0-9;]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\))/;
const STACKED = /^::stacked\[([^\]\n]+)\](?:\{([^}\n]*)\})?\s*$/;
// Parts without color= cycle through these: the four status colors, then extras.
const PART_COLORS = [
	FG_BLUE,
	FG_GREEN,
	FG_YELLOW,
	FG_RED,
	"\x1b[38;2;180;120;220m",
	"\x1b[38;2;90;190;200m",
	"\x1b[38;2;220;140;80m",
	"\x1b[38;2;150;150;150m",
];
// One glyph per part, so a part still reads without color.
const PART_GLYPHS = ["█", "▓", "▒", "░"];
// Left-aligned partial blocks, 1/8 to 7/8 of a cell.
const PARTIAL = " ▏▎▍▌▋▊▉";
const MAX_BAR_LABEL = 20;
const MAX_V_COL = 10;
const ATTR = /(\w+)=(?:"((?:[^"\\]|\\.)*)"|([^\s"}]+))/g;
const FENCE = /^\s*(```|~~~)/;
const MIN_CARD = 16;
const MAX_CHART = 72;
// NBSP pads the axis gutter: Markdown would strip or code-block leading spaces.
const NBSP = "\u00a0";
const COLORS: Record<string, string> = {
	red: FG_RED,
	green: FG_GREEN,
	yellow: FG_YELLOW,
	blue: FG_BLUE,
};
// Dark tints of COLORS for badge backgrounds: the colored text stays readable on them.
const BADGE_BG: Record<string, string> = {
	red: "\x1b[48;2;70;32;32m",
	green: "\x1b[48;2;30;58;40m",
	yellow: "\x1b[48;2;68;56;24m",
	blue: "\x1b[48;2;30;45;80m",
};
const SPARK = "▁▂▃▄▅▆▇█";
const MAX_SPARK = 60;
// A file path with a directory and an extension, optionally `:line[:col]`: `src/a.ts:12`.
const PATH = String.raw`(?:~|\.{1,2})?\/?(?:[\w.@-]+\/)+[\w@-][\w.@-]*\.[A-Za-z]\w{0,7}(?::\d+(?::\d+)?)?`;
const PATH_ONLY = new RegExp(`^${PATH}$`);
// A code span is matched first, so `:red[x]` inside backticks stays literal. Order matters:
// a link or URL is consumed whole before the path pattern could match inside it.
const INLINE = new RegExp(
	[
		String.raw`(?<ticks>\`+)(?<code>[^\`]*?)\k<ticks>`,
		String.raw`(?<![\w:]):(?<name>red|green|yellow|blue|spark)\[(?<text>[^\]\n]+)\]`,
		String.raw`(?<![\w:]):badge\[(?<badge>[^\]\n]+)\](?:\{(?<badgeAttrs>[^}\n]*)\})?`,
		String.raw`(?<!!)\[(?<linkText>[^\]\n]+)\]\((?<href>https?:\/\/[^\s)]+)\)`,
		String.raw`(?<![\w/(<\]])(?<url>https?:\/\/[^\s<>()\]]*[^\s<>()\].,;:!?'"])`,
		String.raw`(?<![\w/.:~@-])(?<path>${PATH})(?![\w/@-])`,
	].join("|"),
	"g",
);

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

/**
 * Plain badges have no padding. Links include a clickable space on either side, so the
 * tinted hit area extends beyond the letters. OSC 8 uses BEL termination (a `\` would
 * start a Markdown escape). `\x1b[39m`/`\x1b[49m` reset only the colors, so bold or
 * italic around the badge survives.
 */
function badge(text: string, color: string, href?: string): string {
	const key = COLORS[color] ? color : "blue";
	const linked = href ? `\x1b]8;;${literal(href)}\x07\u00a0${text}\u00a0\x1b]8;;\x07` : text;
	return `${BADGE_BG[key]}${COLORS[key]}${linked}\x1b[39m\x1b[49m`;
}

/** `example.com` for `https://www.example.com/a/b`. */
function host(url: string): string {
	try {
		return new URL(url).host.replace(/^www\./, "");
	} catch {
		return url;
	}
}

type InlineGroups = Partial<Record<string, string>>;

/** One inline match: directives, plus links, bare URLs and file paths as badges. */
function inlineMatch(match: string, g: InlineGroups): string {
	if (g.ticks) return g.code && PATH_ONLY.test(g.code) ? badge(literal(g.code), "green") : match;
	if (g.badge) return badge(g.badge, attrs(g.badgeAttrs).color ?? "");
	if (g.path) return badge(literal(g.path), "green");
	// Without OSC 8 the badge would hide the URL: keep Pi's own link rendering.
	const links = getCapabilities().hyperlinks;
	if (g.href) return links ? badge(g.linkText ?? "", "blue", g.href) : match;
	if (g.url) return links ? badge(literal(host(g.url)), "blue", g.url) : match;
	if (g.name && g.name !== "spark") return `${COLORS[g.name]}${g.text}\x1b[39m`;
	const spark = sparkline(g.text ?? "");
	return spark ? `${FG_BLUE}${spark}\x1b[39m` : match;
}

export function colorInline(line: string): string {
	return line.replace(INLINE, (match, ...rest) => inlineMatch(match, rest.at(-1) as InlineGroups));
}

/** {@link colorInline} on every line outside code fences. */
function inlineLines(lines: readonly string[]): string[] {
	let fenced = false;
	return lines.map((line) => {
		if (FENCE.test(line)) fenced = !fenced;
		return fenced ? line : colorInline(line);
	});
}

function attrs(raw: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [, key, quoted, bare] of (raw ?? "").matchAll(ATTR)) {
		// Only `\"` is an escape, so a Windows path keeps its backslashes.
		if (key) out[key] = quoted?.replaceAll('\\"', '"') ?? bare ?? "";
	}
	return out;
}

/** `color=red|green|yellow|blue`; anything else keeps the default accent. */
function colorOf(name: string | undefined): string {
	return (name && COLORS[name]) || FG_BLUE;
}

/**
 * X-axis rows under a plot `cols` wide: tick marks on the baseline and labels
 * placed left to right, skipping any label that would touch the previous one.
 */
function xAxis(
	labels: readonly string[],
	at: (i: number) => number,
	cols: number,
): [string, string] {
	const rule = Array.from({ length: cols }, () => "─");
	let text = "";
	labels.forEach((raw, i) => {
		const label = truncateToWidth(raw, MAX_BAR_LABEL, "…");
		const size = visibleWidth(label);
		const col = Math.min(cols - 1, at(i));
		const start = Math.max(0, Math.min(cols - size, col - (size >> 1)));
		const used = visibleWidth(text);
		if ((used > 0 && start <= used) || start + size > cols) return;
		rule[col] = "┬";
		text += NBSP.repeat(start - used) + literal(label);
	});
	return [rule.join(""), text];
}

function axisNumber(n: number): string {
	return String(Number(n.toPrecision(4)));
}

type Bar = { value: number; label: string; color: string; vertical: boolean; height: number };

function parseBar(line: string): Bar | undefined {
	const match = BAR.exec(line);
	const value = Number(match?.[1]);
	if (!match || !Number.isFinite(value)) return undefined;
	const { label = "", color, direction, height } = attrs(match[2]);
	return {
		value,
		label,
		color: colorOf(color),
		vertical: direction === "vertical",
		height: Math.min(20, Math.max(3, Number(height) || 8)),
	};
}

/** Vertical bar chart: y axis from 0 to max, each value just above its bar, label row. */
export function renderVerticalBars(bars: readonly Bar[], width: number): string[] | undefined {
	const max = Math.max(...bars.map((b) => b.value), 0);
	const height = bars[0]?.height ?? 8;
	const numbers = bars.map((b) => axisNumber(b.value));
	// Tick k sits at the top edge of bar row k (value max · (height - k) / height):
	// max on top, half when the rows split evenly. The baseline carries 0.
	const ticks = new Array<string>(height).fill("");
	ticks[0] = axisNumber(max);
	if (height % 2 === 0) ticks[height / 2] = axisNumber(max / 2);
	const gutter = Math.max(1, ...ticks.map((t) => t.length));
	const natural = Math.max(
		...bars.map((b, i) => Math.max(visibleWidth(b.label), numbers[i]?.length ?? 0)),
	);
	const room = Math.min(width, MAX_CHART) - gutter - 1;
	const col = Math.min(MAX_V_COL, natural, Math.floor((room + 1) / bars.length) - 1);
	// Too narrow to keep each value readable: the caller falls back to horizontal.
	if (col < Math.max(...numbers.map((n) => n.length), 2)) return undefined;
	const cell = (text: string, style = "") => {
		const fitted = truncateToWidth(text, col, "…");
		const pad = NBSP.repeat(col - visibleWidth(fitted));
		return style ? `${style}${literal(fitted)}${RST}${pad}` : `${literal(fitted)}${pad}`;
	};
	const pad = (text: string) => literal(NBSP.repeat(gutter - text.length) + text);
	const axis = (tick: string | undefined) =>
		tick === undefined ? NBSP.repeat(gutter + 1) : `${pad(tick)}${FG_DIM}${tick ? "┤" : "│"}${RST}`;
	const row = (cells: string[]) => cells.join(NBSP);
	const levels = bars.map((b) =>
		max > 0 ? Math.round((Math.max(0, b.value) / max) * height * 8) : 0,
	);
	// Row r counts up from the baseline; row `height` holds the tallest bar's value.
	const rows: string[] = [];
	for (let r = height; r >= 0; r--) {
		const cells = bars.map((bar, i) => {
			const filled = Math.ceil((levels[i] ?? 0) / 8);
			if (r === filled) return cell(numbers[i] ?? "");
			if (r > filled) return NBSP.repeat(col);
			const level = Math.min(8, (levels[i] ?? 0) - r * 8);
			return `${bar.color}${(SPARK[level - 1] ?? "█").repeat(col)}${RST}`;
		});
		const tick = r < height ? (ticks[height - 1 - r] ?? "") : undefined;
		if (r < height || cells.some((c) => !c.startsWith(NBSP))) rows.push(axis(tick) + row(cells));
	}
	rows.push(`${pad("0")}${FG_DIM}└${"─".repeat(bars.length * (col + 1) - 1)}${RST}`);
	rows.push(axis(undefined) + row(bars.map((b) => cell(b.label))));
	return rows;
}

/** Horizontal bar chart: label column, bar scaled to the largest value, value text, x axis. */
export function renderBars(bars: readonly Bar[], width: number): string[] {
	const max = Math.max(...bars.map((b) => b.value), 0);
	const labels = bars.map((b) => truncateToWidth(b.label, MAX_BAR_LABEL, "…"));
	const labelWidth = Math.max(...labels.map((l) => visibleWidth(l)));
	const numbers = bars.map((b) => axisNumber(b.value));
	const barWidth = Math.max(
		1,
		Math.min(width, MAX_CHART) - labelWidth - Math.max(...numbers.map((n) => n.length)) - 2,
	);
	const rows = bars.map((bar, i) => {
		const eighths = max > 0 ? Math.round((Math.max(0, bar.value) / max) * barWidth * 8) : 0;
		const fill = "█".repeat(eighths >> 3) + (PARTIAL[eighths & 7] ?? "").trim();
		const label = labels[i] ?? "";
		const gap = NBSP.repeat(labelWidth - visibleWidth(label));
		const axis = `${FG_DIM}│${RST}`;
		return `${literal(label)}${gap}${axis}${bar.color}${fill}${RST} ${literal(numbers[i] ?? "")}`;
	});
	// Ticks at 0, half and max; a full bar fills `barWidth` cells, so max sits on the last one.
	const at = [0, (barWidth - 1) >> 1, barWidth - 1];
	const [rule, text] = xAxis(
		["0", axisNumber(max / 2), axisNumber(max)],
		(i) => at[i] ?? 0,
		barWidth,
	);
	const indent = NBSP.repeat(labelWidth);
	return [...rows, `${indent}${FG_DIM}└${rule}${RST}`, `${indent}${NBSP}${text}`];
}

type Part = { value: number; label: string; color?: string };

function parsePart(line: string): Part | undefined {
	const match = STACKED.exec(line);
	const value = Number(match?.[1]);
	if (!match || !Number.isFinite(value) || value < 0) return undefined;
	const { label = "", color } = attrs(match[2]);
	return { value, label, color: color ? COLORS[color] : undefined };
}

/**
 * Shares of one whole as a stacked 100% bar over a legend of value and percent.
 * Each part has its own glyph as well as its color, so color is never the only
 * signal. A part above zero keeps at least one cell.
 */
export function renderStacked(parts: readonly Part[], width: number): string[] {
	const total = parts.reduce((sum, p) => sum + p.value, 0);
	const colors = parts.map((p, i) => p.color ?? PART_COLORS[i % PART_COLORS.length] ?? FG_BLUE);
	const glyphs = parts.map((_, i) => PART_GLYPHS[i % PART_GLYPHS.length] ?? "█");
	const shown = parts.filter((p) => p.value > 0).length;
	const spare = Math.max(0, Math.min(width, MAX_CHART) - shown);
	// Cumulative rounding keeps the cells summing to the bar width.
	let acc = 0;
	let used = 0;
	const bar = parts
		.map((p, i) => {
			if (p.value <= 0 || total <= 0) return "";
			acc += p.value;
			const end = Math.round((acc / total) * spare);
			const cells = 1 + end - used;
			used = end;
			return `${colors[i]}${(glyphs[i] ?? "").repeat(cells)}${RST}`;
		})
		.join("");
	const labels = parts.map((p) => truncateToWidth(p.label, MAX_BAR_LABEL, "…"));
	const labelWidth = Math.max(...labels.map((l) => visibleWidth(l)));
	const numbers = parts.map((p) => axisNumber(p.value));
	const numberWidth = Math.max(...numbers.map((n) => n.length));
	const legend = parts.map((p, i) => {
		const label = labels[i] ?? "";
		const number = numbers[i] ?? "";
		const pct = total > 0 ? `${Math.round((p.value / total) * 100)}%` : "0%";
		const gap = NBSP.repeat(labelWidth - visibleWidth(label) + 1 + numberWidth - number.length);
		return `${colors[i]}●${RST}${NBSP}${literal(label)}${gap}${literal(number)}${NBSP}${FG_DIM}${literal(pct)}${RST}`;
	});
	return bar ? [bar, ...legend] : legend;
}

/**
 * Backslash-escape Markdown punctuation so the text keeps its characters and width.
 * Brackets and parens stay bare: Pi reads `\(`…`\)` and `\[`…`\]` as LaTeX delimiters.
 */
function literal(text: string): string {
	return text.replace(/[!-'*-/:-@\\^_`{-~]/g, "\\$&");
}

/**
 * One card: optional label, accent title, italic subtitle and Markdown body. A card
 * with only a value and label is small; a subtitle or body makes it full width.
 */
type Card = { title: string; label: string; subtitle: string; color: string; body: string[] };

function parseCard(line: string): Card | undefined {
	const match = CARD.exec(line);
	if (!match) return undefined;
	const { label = "", subtitle = "", color } = attrs(match[2]);
	return { title: match[1] ?? "", label, subtitle, color: colorOf(color), body: [] };
}

const isFull = (card: Card) => card.subtitle !== "" || card.body.some((line) => line.trim());

/** Text rows of one card wrapped to `inner` columns; the body is rendered as Markdown. */
function cardLines({ title, label, subtitle, color, body }: Card, inner: number): string[] {
	const wrap = (text: string, style = "") =>
		text ? wrapTextWithAnsi(`${style}${text}${RST}`, inner) : [];
	const head = [...wrap(label), ...wrap(title, `${BOLD}${color}`), ...wrap(subtitle, ITALIC)];
	const text = inlineLines(body).join("\n").trim();
	const rendered = text ? [...new Markdown(text, 0, 0, getMarkdownTheme()).render(inner)] : [];
	while (rendered.length > 0 && !rendered.at(-1)?.trim()) rendered.pop();
	return [...head, ...(head.length > 0 && rendered.length > 0 ? [""] : []), ...rendered];
}

/** Dim rounded frame `width` columns wide, padded with blank rows to `height`. */
function box(lines: readonly string[], width: number, height: number): string[] {
	const inner = width - 4;
	const rule = "─".repeat(width - 2);
	const row = (line: string) => {
		const fitted = truncateToWidth(line, inner, "…");
		const pad = " ".repeat(Math.max(0, inner - visibleWidth(fitted)));
		// Escape the text, not the escape sequences between it.
		const text = fitted.split(ESCAPE_SEQ).map((s, i) => (i % 2 ? s : literal(s)));
		return `${FG_DIM}│${RST} ${text.join("")}${RST}${pad} ${FG_DIM}│${RST}`;
	};
	return [
		`${FG_DIM}╭${rule}╮${RST}`,
		...lines.map(row),
		...Array.from({ length: height - lines.length }, () => row("")),
		`${FG_DIM}╰${rule}╯${RST}`,
	];
}

/** Cards side by side, as many per row as fit `width`. */
function cardRow(cards: readonly Card[], width: number): string[] {
	const perRow = Math.max(1, Math.min(cards.length, Math.floor((width + 1) / (MIN_CARD + 1))));
	const cardWidth = Math.floor((width + 1) / perRow) - 1;
	const rows: string[] = [];
	for (let i = 0; i < cards.length; i += perRow) {
		const texts = cards.slice(i, i + perRow).map((card) => cardLines(card, cardWidth - 4));
		const height = Math.max(...texts.map((t) => t.length));
		const boxes = texts.map((t) => box(t, cardWidth, height));
		rows.push(...(boxes[0] ?? []).map((_, r) => boxes.map((b) => b[r]).join(" ")));
	}
	return rows;
}

/** Runs of small cards side by side; a full card spans the width on its own. */
export function renderCards(cards: readonly Card[], width: number): string[] {
	const rows: string[] = [];
	for (let i = 0; i < cards.length; ) {
		let end = i + 1;
		if (!isFull(cards[i] as Card)) while (end < cards.length && !isFull(cards[end] as Card)) end++;
		rows.push(...cardRow(cards.slice(i, end), width));
		i = end;
	}
	return rows;
}

export function renderDirectives(markdown: string, width: number): string {
	// Cheap pre-check: most replies have no directive, link or path at all.
	if (!/::(?:card|bar|stacked|image)|:[a-z]+\[|https?:\/\/|\w\//.test(markdown)) return markdown;
	const out: string[] = [];
	let fenced = false;
	let cards: Card[] = [];
	let bars: Bar[] = [];
	let parts: Part[] = [];
	// Blank lines keep each block a paragraph of its own.
	const flush = () => {
		if (cards.length > 0) out.push("", ...renderCards(cards, width), "");
		// The first bar's direction= picks the layout for the whole chart.
		const vertical = bars[0]?.vertical ? renderVerticalBars(bars, width) : undefined;
		if (bars.length > 0) out.push("", ...(vertical ?? renderBars(bars, width)), "");
		if (parts.length > 0) out.push("", ...renderStacked(parts, width), "");
		cards = [];
		bars = [];
		parts = [];
	};
	for (const line of markdown.split("\n")) {
		// Lines right after a card, up to a blank line or the next block directive, are
		// its body; a fence in the body stays whole.
		const last = cards.at(-1);
		if (last && (fenced || (line.trim() && !/^::\w/.test(line)))) {
			if (FENCE.test(line)) fenced = !fenced;
			last.body.push(line);
			continue;
		}
		if (FENCE.test(line)) fenced = !fenced;
		const card = fenced || width < MIN_CARD ? undefined : parseCard(line);
		if (card) {
			if (bars.length > 0 || parts.length > 0) flush();
			cards.push(card);
			continue;
		}
		const bar = fenced || width < MIN_CARD ? undefined : parseBar(line);
		if (bar) {
			if (cards.length > 0 || parts.length > 0) flush();
			bars.push(bar);
			continue;
		}
		const part = fenced || width < MIN_CARD ? undefined : parsePart(line);
		if (part) {
			if (cards.length > 0 || bars.length > 0) flush();
			parts.push(part);
			continue;
		}
		const image = fenced ? undefined : parseImage(line, attrs);
		const block = image ? renderImage(image, width) : undefined;
		if (block) {
			flush();
			out.push("", ...block, "");
			continue;
		}
		flush();
		out.push(fenced ? line : colorInline(line));
	}
	flush();
	return out.join("\n");
}

/** The display pipeline for assistant Markdown: folds, Mermaid, math, then directives. */
export function renderDisplayMarkdown(markdown: string, width: number): string {
	const unfolded = renderFolds(markdown, foldsOpen());
	return renderDirectives(renderMathBlocks(renderMermaidBlocks(unfolded, width), width), width);
}

export default function directivesExtension(pi: ExtensionAPI): void {
	pi.registerMarkdownTransformer?.(
		(markdown, { availableWidth }) => renderDisplayMarkdown(markdown, availableWidth),
		{ messageTypes: ["assistant"] },
	);
	// Entry renderers (the /btw card) bypass Pi's chain; share the same pipeline.
	setMarkdownTransform(renderDisplayMarkdown);
}
