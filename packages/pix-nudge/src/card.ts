/**
 * card.ts — one transcript shape for every nudge.
 *
 * Collapsed (default): a single `<nudge icon> nudge <summary> · <kind>` row in the
 * shared collapsed-row layout, but with the catalog `nudge` icon in `accent`: a
 * nudge is advice, not a warning. Expanded (host expand toggle or a left click on
 * the card): the row plus the full nudge text, so collapsing hides nothing for good.
 *
 * The capability orientation is a custom MESSAGE (the model must read it); the
 * tools/loop nudges reach the model through the tool result and show the user a
 * custom ENTRY (no model context). Both render through `nudgeCard`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MouseRegion, Text, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { bodyLine, padIcon } from "@xynogen/pix-pretty/utils";

export const NUDGE_ENTRY = "pix-nudge";
export const CAPABILITY_MESSAGE = "pix-capability-nudge";

export interface NudgeCard {
	/** Short label after the summary: "orientation", "reminder", "tool", "loop". */
	kind: string;
	/** One-line gist shown while collapsed. */
	summary: string;
	/** Full text shown when expanded — exactly what the model received. */
	body: string;
}

type CardTheme = {
	fg: (role: "accent" | "toolTitle" | "dim" | "muted", text: string) => string;
	bold: (text: string) => string;
};

/** Same layout as pix-pretty `formatCollapsedToolRow`, with a hint icon instead of a status. */
export function nudgeRow(card: Pick<NudgeCard, "kind" | "summary">, theme: CardTheme): string {
	return [
		`${theme.fg("accent", padIcon(icon("nudge")))} ${theme.fg("toolTitle", theme.bold("nudge"))}`,
		card.summary && theme.fg("dim", card.summary),
		`${theme.fg("muted", "·")} ${theme.fg("muted", card.kind)}`,
	]
		.filter(Boolean)
		.join(" ");
}

/** Collapsed: one row. Expanded: plus pix-pretty `bodyLine` body rows. */
export function nudgeCard(card: NudgeCard, expanded: boolean, theme: CardTheme) {
	const head = new Text(nudgeRow(card, theme), 0, 0);
	if (!expanded) return head;
	return {
		// ponytail: 3 = pi-tui width of BODY_PAD (one tab). Wrap first so every row keeps the indent.
		render: (width: number): string[] => [
			...head.render(width),
			...card.body
				.split("\n")
				.flatMap((line) => wrapTextWithAnsi(line, Math.max(10, width - 3)))
				.map((line) => bodyLine(line, theme, (s) => theme.fg("dim", s))),
		],
		invalidate: () => head.invalidate(),
	};
}

/**
 * Click-to-toggle card, like Pi's own tool results. Pi gives custom renderers no
 * click handling, so a left click flips a local override of the host `expanded`
 * (Ctrl+O). A host toggle rebuilds the card and resets the override.
 */
export function clickableNudgeCard(card: NudgeCard, hostExpanded: boolean, theme: CardTheme) {
	let expanded = hostExpanded;
	let view = nudgeCard(card, expanded, theme);
	return new MouseRegion(
		{ render: (w: number) => view.render(w), invalidate: () => view.invalidate() },
		(event) => {
			if (event.type !== "click" || event.button !== "left") return undefined;
			expanded = !expanded;
			view = nudgeCard(card, expanded, theme);
			return { handled: true };
		},
	);
}

/** Register both renderers once per factory run. */
export function registerNudgeRenderers(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<NudgeCard>(NUDGE_ENTRY, (entry, { expanded }, theme) =>
		entry.data ? clickableNudgeCard(entry.data, expanded, theme) : undefined,
	);
	// The message content is the model-facing text, so it doubles as the card body.
	pi.registerMessageRenderer<Omit<NudgeCard, "body">>(
		CAPABILITY_MESSAGE,
		(message, { expanded }, theme) => {
			const body =
				typeof message.content === "string"
					? message.content
					: message.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
			const meta = message.details ?? {
				kind: "orientation",
				summary: body.split("\n", 1)[0] ?? "",
			};
			return clickableNudgeCard({ ...meta, body }, expanded, theme);
		},
	);
}
