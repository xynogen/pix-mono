import { type Color, type Component, mixColors, Text, visibleWidth } from "@earendil-works/pi-tui";
import { FG_RULE, hasAnsi, RST } from "./ansi.ts";
import { MAX_PREVIEW_LINES } from "./config.ts";
import { fadeRowsOf, pluralize } from "./text.ts";
import type { TextComponentCtor, TextComponentLike } from "./types.ts";
import { terminalWidth } from "./utils.ts";

type ResultComponent = {
	render(width: number): string[];
	invalidate(): void;
	handleInput?(data: string): void;
	wantsKeyRelease?: boolean;
};
type FramableComponent = Partial<ResultComponent> & Partial<TextComponentLike>;
type ResultFrameTheme = StatusRuleTheme;

const RESULT_FRAME = Symbol("pix.resultFrame");
type FramedResultComponent = ResultComponent & {
	[RESULT_FRAME]: {
		component: FramableComponent;
		update(theme: ResultFrameTheme, isError: boolean, section: boolean): void;
	};
};

/** Paints a rule line. Callers pass `(s) => theme.fg(status, s)` so the frame
 *  tint follows the active theme (success/error/warning). Default = neutral FG_RULE. */
export type RulePaint = (glyphs: string) => string;

/** Render a full-width solid rule. */
export function rule(w: number, paint?: RulePaint): string {
	const glyphs = "─".repeat(w);
	return paint ? paint(glyphs) : `${FG_RULE}${glyphs}${RST}`;
}

/** Theme slice for {@link fadeRulePaint}. Without `colors`/`style` the rule stays flat. */
export type StatusRuleTheme = {
	fg: (key: "success" | "error", text: string) => string;
	colors?: Readonly<Record<string, Color | undefined>>;
	style?: (text: string, style: { fg: Color }) => string;
};

/**
 * Status-colored rule paint that fades in on the left and out on the right: the last
 * `fadeColumns` cells at each end mix toward the tool background. Themes without color
 * data get the plain `theme.fg(role, …)` rule.
 */
export function fadeRulePaint(
	theme: StatusRuleTheme,
	role: "success" | "error",
	fadeColumns = 8,
): RulePaint {
	return (glyphs) => {
		const cells = [...glyphs];
		const edge = Math.min(fadeColumns, Math.floor(cells.length / 2));
		const fg = theme.colors?.[role];
		const bg = theme.colors?.[role === "error" ? "toolErrorBg" : "toolSuccessBg"];
		if (!fg || !bg || !theme.style || edge < 1) return theme.fg(role, glyphs);
		// Cell i from the edge (0 = outermost) is faintest at the edge, full color past `edge`.
		// Call as a method: Pi's Theme.style reads `this`.
		const cell = (ch: string, i: number) =>
			theme.style?.(ch, { fg: mixColors(fg, bg, 1 - (i + 1) / (edge + 1)) }) ?? ch;
		const left = cells.slice(0, edge).map(cell).join("");
		const right = cells
			.slice(-edge)
			.map((ch, i) => cell(ch, edge - 1 - i))
			.join("");
		return left + theme.fg(role, cells.slice(edge, -edge).join("")) + right;
	};
}

/** Narrow theme for helpers that paint only `muted`. Pi's Theme and FgTheme both fit. */
type MutedTheme = { fg: (key: "muted", text: string) => string };

/** Matches an `=== label ===` separator line (a common shell/echo idiom). */
const SECTION_RE = /^\s*={2,}\s*(.+?)\s*={2,}\s*$/;

/** Fixed dash count before a left-aligned section label. */
const SECTION_RULE_LEAD = 4;

/**
 * If `line` is an `=== label ===` separator, render it as a left-aligned
 * section divider (`──── label ───────────`); otherwise return null. Callers
 * fall back to their normal per-line rendering on null. Fills the full `width`
 * so the divider aligns with the surrounding tool frame. Label and rule both
 * use the muted role — theme-driven, ANSI-safe.
 */
export function sectionRule(line: string, theme: MutedTheme, width: number): string | null {
	const m = SECTION_RE.exec(line);
	if (!m || hasAnsi(line)) return null;
	const label = ` ${m[1]} `;
	const trail = width - SECTION_RULE_LEAD - visibleWidth(label);
	// Label fits → lead rule + trailing fill. Too long to fill → don't force a
	// full-width rule; wrap it snugly with 2 dashes each side (`── long text ──`).
	const [lead, tail] = trail >= 2 ? [SECTION_RULE_LEAD, trail] : [2, 2];
	return theme.fg("muted", `${"─".repeat(lead)}${label}${"─".repeat(tail)}`);
}

/**
 * Body indent: one tab. pi-tui renders `\t` as 3 cells, the title column after
 * the 2-cell status icon + space.
 */
export const BODY_PAD = "\t";

/**
 * One tool-result body line, aligned under the tool title. An `=== label ===` line
 * becomes a full-width section rule. Other lines go through `paint`.
 */
export function bodyLine(
	line: string,
	theme: MutedTheme,
	paint: (line: string) => string = (s) => s,
): string {
	// ponytail: 3 = pi-tui tab width. Use visibleWidth if BODY_PAD stops being one tab.
	return `${BODY_PAD}${sectionRule(line, theme, terminalWidth() - 3) ?? paint(line)}`;
}

/** Renderer context slice that knows the user's expand key (Pi's `ToolRenderContext`). */
export type ExpandHintCtx = {
	keyHint?: (keybinding: "app.tools.expand", description: string) => string;
	/** Expanded view: renderers that take this context show every row, no hint. */
	expanded?: boolean;
};

/**
 * `(ctrl+o to expand)` with the user's configured key, styled like Pi's own hint.
 * Without a host `keyHint` (tests, old hosts), the key falls back to `ctrl+o`.
 */
export function expandHint(theme: MutedTheme, ctx?: ExpandHintCtx): string {
	const hint =
		ctx?.keyHint?.("app.tools.expand", "to expand") ?? theme.fg("muted", "ctrl+o to expand");
	return `${theme.fg("muted", "(")}${hint}${theme.fg("muted", ")")}`;
}

/**
 * Muted `… N more lines (ctrl+o to expand)` footer for a truncated tool-result body.
 * Pass the renderer context so the hint shows the user's own expand key.
 */
export function moreLines(count: number, theme: MutedTheme, ctx?: ExpandHintCtx): string {
	return `${BODY_PAD}${theme.fg("muted", `… ${pluralize(count, "more line")} `)}${expandHint(theme, ctx)}`;
}

/** Decorate completed tool output with status-colored default chrome. */
export function frameToolResult<T extends FramableComponent & { setText(value: string): void }>(
	component: T,
	theme: ResultFrameTheme,
	isError: boolean,
): ResultComponent & { setText(value: string): void; getText?: () => string };
export function frameToolResult(
	component: FramableComponent,
	theme: ResultFrameTheme,
	isError: boolean,
): ResultComponent;
export function frameToolResult(
	component: FramableComponent,
	theme: ResultFrameTheme,
	isError: boolean,
): ResultComponent {
	return decorateToolResult(component, theme, isError, false);
}

/** Decorate explicit expanded/detail sections with solid top and bottom rules. */
export function frameToolSection(
	component: FramableComponent,
	theme: ResultFrameTheme,
	isError: boolean,
): ResultComponent {
	return decorateToolResult(component, theme, isError, true);
}

function decorateToolResult(
	component: FramableComponent,
	theme: ResultFrameTheme,
	isError: boolean,
	section: boolean,
): ResultComponent & Partial<TextComponentLike> {
	const existing = component as Partial<FramedResultComponent>;
	if (existing[RESULT_FRAME]) {
		existing[RESULT_FRAME].update(theme, isError, section);
		return component as ResultComponent;
	}
	let frameTheme = theme;
	let failed = isError;
	let solid = section;
	const framed: FramedResultComponent & Partial<TextComponentLike> = {
		[RESULT_FRAME]: {
			component,
			update(nextTheme, nextError, nextSection) {
				frameTheme = nextTheme;
				failed = nextError;
				solid = nextSection;
			},
		},
		wantsKeyRelease: component.wantsKeyRelease,
		render(width) {
			const paint = fadeRulePaint(frameTheme, failed ? "error" : "success");
			const lines = component.render?.(width) ?? [];
			return solid ? sectionFrame(lines, [], width, paint) : ruleFrame(lines, [], width, paint);
		},
		invalidate() {
			component.invalidate?.();
		},
		handleInput: component.handleInput ? (data) => component.handleInput?.(data) : undefined,
	};
	if (component.setText) framed.setText = (value) => component.setText?.(value);
	if (component.getText) framed.getText = () => component.getText?.() ?? "";
	return framed;
}

/** Remove the result frame while preserving its underlying renderer component. */
export function unframeToolResult<T extends FramableComponent>(component: T): T {
	const framed = component as Partial<FramedResultComponent>;
	return (framed[RESULT_FRAME]?.component ?? component) as T;
}

function isTextComponent(component: Component): component is TextComponentLike {
	return typeof (component as Partial<TextComponentLike>).setText === "function";
}

/** The prior render's text component (unframed) when it has one, else a fresh one. */
export function reuseText(
	last: Component | undefined,
	TextComponent: TextComponentCtor = Text,
): TextComponentLike {
	const prior = last && unframeToolResult(last);
	return prior && isTextComponent(prior) ? prior : new TextComponent("", 0, 0);
}

/**
 * Default completed-tool chrome: unchanged body, full-width solid close, then
 * footer lines. Existing callers inherit this distro-wide presentation.
 */
export function ruleFrame(
	bodyLines: string[],
	footerLines: string[] = [],
	width?: number,
	paint?: RulePaint,
): string[] {
	return [...bodyLines, rule(width ?? terminalWidth(), paint), ...footerLines];
}

/**
 * Command-output body: the first MAX_PREVIEW_LINES rows (all when expanded) with a
 * fading tail and an "… N more" footer. Completed output closes with a status rule;
 * partial output stays unframed. Returns the rows; the caller fills the background.
 */
export function outputBodyRows(
	lines: string[],
	theme: StatusRuleTheme & MutedTheme & Parameters<typeof fadeRowsOf>[1],
	ctx: ExpandHintCtx,
	status: "success" | "error",
	partial: boolean,
): string[] {
	const maxShow = ctx.expanded ? lines.length : MAX_PREVIEW_LINES;
	const footer = lines.length > maxShow ? [moreLines(lines.length - maxShow, theme, ctx)] : [];
	// Fade the last preview rows instead of a hard cut before the "… N more" row.
	const body = fadeRowsOf(
		lines.slice(0, maxShow + 1).map((line) => bodyLine(line, theme)),
		theme,
		maxShow,
	);
	return partial
		? [...body, ...footer]
		: ruleFrame(body, footer, terminalWidth(), fadeRulePaint(theme, status));
}

/** Explicit solid top/bottom frame for sections that need stronger separation. */
export function sectionFrame(
	bodyLines: string[],
	footerLines: string[] = [],
	width?: number,
	paint?: RulePaint,
): string[] {
	const r = rule(width ?? terminalWidth(), paint);
	return [r, ...bodyLines, r, ...footerLines];
}
