import {
	type Component,
	MouseRegion,
	type mixColors,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { BG_BASE, BG_ERROR, BOLD, BOLD_OFF, hasAnsi } from "./ansi.ts";
import { MAX_PREVIEW_LINES } from "./config.ts";
import {
	BODY_PAD,
	bodyLine,
	type ExpandHintCtx,
	moreLines,
	type RulePaint,
	ruleFrame,
	unframeToolResult,
} from "./frame.ts";
import { icon } from "./icon-catalog.ts";
import { fadeLine, fadePaint, fadeRowsOf, fadeText, normalizeLineEndings } from "./text.ts";
import type { FgTheme } from "./types.ts";
import { fillToolBackground, terminalWidth } from "./utils.ts";
export function renderToolError(error: string, theme: FgTheme): string {
	return fillToolBackground(theme.fg("error", error), BG_ERROR);
}

export type CollapsedToolStatus = "success" | "error" | "warning";

/**
 * Status glyphs for collapsed tool rows. `⚠` (warning) is East-Asian *wide*
 * (2 cells) while `✓`/`✗` are 1 cell — render them through `padIcon` so every
 * marker occupies the same fixed column and rows stay vertically aligned.
 * (`⚡` is reserved for strength / model-score badges, not warnings.)
 */
export const COLLAPSED_TOOL_GLYPH: Record<CollapsedToolStatus, string> = {
	get success() {
		return icon("status.ok");
	},
	get warning() {
		return icon("status.warn");
	},
	get error() {
		return icon("status.error");
	},
};

/**
 * Normalize a marker glyph to a fixed display width so mixed 1-cell and 2-cell
 * (East-Asian wide / emoji) icons align in a column and the following text
 * always starts at the same offset. Measures actual terminal cells via pi-tui's
 * `visibleWidth` (ANSI-aware), then right-pads with spaces. A glyph already
 * at/over `width` is returned unchanged (never truncated — clipping a marker is
 * worse than a 1-cell overflow).
 *
 * The default width (2) makes every marker occupy exactly two cells, so with a
 * single separator space the following text always starts at the same column:
 *
 *   `${padIcon("✓")} bash`   // "✓  bash"  (1 cell + 1 pad + separator)
 *   `${padIcon("⚠")} bash`   // "⚠ bash"  (2 cells + separator — same column)
 */
export function padIcon(glyph: string, width = 2): string {
	const pad = width - visibleWidth(glyph);
	return pad > 0 ? glyph + " ".repeat(pad) : glyph;
}

/** Fixed icon/name columns align the divider across compact activity widgets. */
export function widgetTitle(
	theme: { fg: (role: "toolTitle" | "muted", text: string) => string },
	glyph: string,
	name: string,
): string {
	return theme.fg("toolTitle", `${padIcon(glyph, 3)} ${name.padEnd(8)}`) + theme.fg("muted", " │ ");
}

/**
 * Join non-empty parts with a middot separator: `dotJoin(["a", "", "b"])` → `"a · b"`.
 * Empty/nullish parts are dropped so callers can pass conditional pieces inline.
 * Pass `paint` (e.g. `(s) => theme.fg("dim", s)`) to tint the separator to theme.
 */
export function dotJoin(
	parts: Array<string | false | null | undefined>,
	paint?: RulePaint,
): string {
	const sep = paint ? paint(" · ") : " · ";
	return parts.filter((p): p is string => Boolean(p)).join(sep);
}

type CollapsedToolTheme = {
	fg: (
		key: "success" | "error" | "warning" | "toolTitle" | "muted" | "dim",
		text: string,
	) => string;
	bold: (text: string) => string;
	colors?: {
		dim: Parameters<typeof mixColors>[0];
		customMessageBg: Parameters<typeof mixColors>[1];
	};
	style?: (text: string, style: { fg: ReturnType<typeof mixColors> }) => string;
};

/** Keep identity/stats fixed; only the trailing activity consumes spare columns. */
export function widgetActivityRow(
	theme: Pick<CollapsedToolTheme, "fg" | "colors" | "style">,
	prefix: string,
	activity: string,
	width: number,
	stats = "",
): string {
	const paint = fadePaint(theme);
	if (stats) {
		const room = width - visibleWidth(stats) - 2;
		if (room < visibleWidth(prefix)) return fadeLine(`${prefix}  ${stats}`, width, paint);
		const body = widgetActivityRow(theme, prefix, activity, room);
		return body + " ".repeat(width - visibleWidth(body) - visibleWidth(stats)) + stats;
	}
	const separator = theme.fg("muted", " · ");
	const room = width - visibleWidth(prefix) - 3;
	if (!activity || room < 1) return fadeLine(prefix, width, paint);
	return prefix + separator + fadeText(activity, room, paint);
}

/** Use the host lifecycle fields so every call has the same status marker. */
export function renderTitle(
	theme: {
		fg: (role: "muted" | "warning" | "error" | "success" | "toolTitle", text: string) => string;
		bold?: (text: string) => string;
	},
	tool: string,
	context: { executionStarted?: boolean; isPartial?: boolean; isError?: boolean } = {},
	action?: string,
): string {
	const complete = context.isPartial === false;
	const role = complete
		? context.isError
			? "error"
			: "success"
		: context.executionStarted
			? "warning"
			: "muted";
	const marker = complete
		? context.isError
			? "status.error"
			: "status.ok"
		: context.executionStarted
			? "status.running"
			: "status.pending";
	const label = action ? `${tool} · ${action}` : tool;
	return `${theme.fg(role, padIcon(icon(marker)))} ${theme.fg("toolTitle", theme.bold?.(label) ?? label)}`;
}

/** Build a plain call renderer; command and rich previews keep their own body. */
export function renderCall<TArgs = Record<string, unknown>>(
	tool: string,
	target: (args: TArgs) => string,
	action?: (args: TArgs) => string | undefined,
) {
	return (
		args: TArgs,
		theme: Parameters<typeof renderTitle>[0] & { fg: (role: "dim", text: string) => string },
		context: Parameters<typeof renderTitle>[2] & {
			lastComponent?: Component;
			state: Record<string, unknown>;
			expanded: boolean;
		},
	): Component => {
		const previous = context.lastComponent && unframeToolResult(context.lastComponent);
		const text =
			previous && "setText" in previous && typeof previous.setText === "function"
				? (previous as Component & { setText(value: string): void })
				: new Text("", 0, 0);
		if (hideCollapsedToolCall(context.state, context.expanded, (value) => text.setText(value)))
			return text;
		const value = target(args);
		text.setText(
			`${renderTitle(theme, tool, context, action?.(args))}${value ? ` ${theme.fg("dim", value)}` : ""}`,
		);
		return text;
	};
}

/** Format the shared one-row content without assuming a render shell. */
export function renderRow(
	theme: CollapsedToolTheme,
	tool: string,
	target: string,
	meta = "",
	status: CollapsedToolStatus = "success",
	width?: number,
): string {
	const marker = padIcon(
		icon(status === "success" ? "status.ok" : status === "error" ? "status.error" : "status.warn"),
	);
	const title = `${theme.fg(status, marker)} ${theme.fg("toolTitle", theme.bold(tool))}`;
	const metadata = meta ? ` ${theme.fg("muted", "·")} ${theme.fg("muted", meta)}` : "";
	if (width === undefined)
		return `${title}${target ? ` ${theme.fg("dim", target)}` : ""}${metadata}`;
	const room = width - visibleWidth(title) - visibleWidth(metadata) - 1;
	const fitted = target && room > 0 ? fadeText(target, room, fadePaint(theme)) : "";
	return truncateToWidth(`${title}${fitted ? ` ${fitted}` : ""}${metadata}`, width, "…");
}

/** Render shared one-row content for tools using the self-rendered shell. */
export function renderCollapsed(
	theme: CollapsedToolTheme,
	tool: string,
	target: string,
	meta = "",
	status: CollapsedToolStatus = "success",
	width?: number,
): string {
	return fillToolBackground(
		renderRow(theme, tool, target, meta, status, width ?? terminalWidth()),
		BG_BASE,
		width,
	);
}

/** Hide renderCall after its paired result has auto-collapsed. */
export function hideCollapsedToolCall(
	state: { collapsed?: boolean },
	expanded: boolean,
	setText: (text: string) => void,
): boolean {
	if (!state.collapsed || expanded) return false;
	setText("");
	return true;
}

export type DimPreviewOptions = {
	maxLines?: number;
	/** Header line shown above the body. NON-FRAMED mode only — in framed mode
	 *  the header is intentionally dropped (the collapsed row already carries the
	 *  count, so a floating header above the frame is redundant). */
	header?: string;
	/** Pattern whose matches are highlighted (bold, themed) inside dim lines.
	 *  A string is matched literally (case-insensitive); a RegExp is used as-is
	 *  (callers pass the compiled search pattern so regex greps highlight too). */
	highlight?: string | RegExp;
	/** Wrap the body in a top/bottom rule frame (overflow below), like bash/ls/mcp. */
	frame?: boolean;
	/** Tint the frame rules (green ok, red error) — same status color as bash/ls. */
	paint?: RulePaint;
	/** Renderer context: the overflow row shows the user's expand key. */
	ctx?: ExpandHintCtx;
};

/** Compile a highlight pattern into a global RegExp, or null when it can't
 *  match anything. Strings match literally (case-insensitive); a RegExp is
 *  re-flagged global so every occurrence on a line lights up. */
function toHighlightRegex(pattern: string | RegExp): RegExp | null {
	if (typeof pattern !== "string") {
		const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
		try {
			return new RegExp(pattern.source, flags);
		} catch {
			return null;
		}
	}
	if (!pattern) return null;
	// Literal string → escape regex metacharacters, case-insensitive.
	const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	try {
		return new RegExp(escaped, "gi");
	} catch {
		return null;
	}
}

function dimLineWithHighlight(line: string, theme: FgTheme, pattern?: string | RegExp): string {
	if (!pattern) return theme.fg("dim", line);
	// A line that already carries ANSI (e.g. a source that emitted its own color)
	// can't be safely index-sliced — a match could land inside an escape and
	// corrupt it. Skip highlighting and dim the whole line instead.
	if (hasAnsi(line)) return theme.fg("dim", line);
	const re = pattern ? toHighlightRegex(pattern) : null;
	if (!re) return theme.fg("dim", line);

	// Themed bold hit: theme.fg carries its own reset, so re-open BOLD after it
	// and close with the bold-off code (\x1b[22m) to avoid leaking bold onward.
	const hit = (s: string) => `${BOLD}${theme.fg("success", s)}${BOLD_OFF}`;
	const parts: string[] = [];
	let start = 0;
	for (let m = re.exec(line); m !== null; m = re.exec(line)) {
		const idx = m.index;
		const text = m[0];
		if (text.length === 0) {
			re.lastIndex++; // zero-width match (e.g. /a*/) — advance to avoid a loop
			continue;
		}
		if (idx > start) parts.push(theme.fg("dim", line.slice(start, idx)));
		parts.push(hit(text));
		start = idx + text.length;
	}
	if (start < line.length) parts.push(theme.fg("dim", line.slice(start)));
	return parts.length > 0 ? parts.join("") : theme.fg("dim", line);
}

export function renderDimPreview(
	text: string,
	theme: FgTheme,
	opts: DimPreviewOptions = {},
): string {
	const maxLines = opts.maxLines ?? MAX_PREVIEW_LINES;
	const highlight = opts.highlight;
	const output = normalizeLineEndings(text).trim() || "done";
	const lines = output.split("\n");
	// Highlight only the preview rows (+1 so the fade still knows it was cut), then fade the
	// last of them instead of a hard cut.
	const body = fadeRowsOf(
		lines
			.slice(0, maxLines + 1)
			.map((line) => bodyLine(line, theme, (l) => dimLineWithHighlight(l, theme, highlight))),
		theme,
		maxLines,
	);
	const header = opts.header ? `${BODY_PAD}${theme.fg("dim", opts.header)}` : undefined;
	const overflow =
		lines.length > maxLines ? moreLines(lines.length - maxLines, theme, opts.ctx) : undefined;

	if (opts.frame) {
		// One shape regardless of line count: a single framed box, no floating
		// header (the collapsed row carries the count). Rules follow status color.
		const out = ruleFrame(body, overflow ? [overflow] : [], undefined, opts.paint);
		return fillToolBackground(out.join("\n"));
	}

	const preview = body;
	if (header) preview.unshift(header);
	if (overflow) preview.push(overflow);
	return fillToolBackground(preview.join("\n"));
}

/**
 * Make a custom message/entry card toggle on left click, like Pi's tool results.
 * Pi gives custom renderers no click handling, so a renderer returns
 * `clickToggle(expanded, (open) => card(open))`: a left click rebuilds the card
 * with the flipped state. A host Ctrl+O rebuild resets it to the host `expanded`.
 * Other mouse events are left unhandled (drag selects text, wheel scrolls).
 */
export function clickToggle(
	expanded: boolean,
	build: (expanded: boolean) => Component,
): MouseRegion {
	let open = expanded;
	let view = build(open);
	return new MouseRegion(
		{ render: (width) => view.render(width), invalidate: () => view.invalidate() },
		(event) => {
			if (event.type !== "click" || event.button !== "left") return undefined;
			open = !open;
			view = build(open);
			return { handled: true };
		},
	);
}
