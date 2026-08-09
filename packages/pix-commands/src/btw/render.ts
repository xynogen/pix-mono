import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { dotJoin } from "@xynogen/pix-pretty/utils";
import { formatDuration as fmtDuration } from "@xynogen/pix-pretty/widget-format";

export interface BtwMessageDetails {
	question: string;
	answer: string;
	/** Captured reasoning/thinking from the child session (empty when none). */
	thinking: string;
	model: string;
	thinkingLevel: string;
	durationMs: number;
	toolUses: number;
	error?: string;
}

// ponytail: thin wrapper keeps old import path; canonical is formatDuration(ms,'btw') in pix-pretty
export function formatDuration(ms: number): string {
	return fmtDuration(ms, "btw");
}

export function registerBtwRenderer(
	pi: Pick<import("@earendil-works/pi-coding-agent").ExtensionAPI, "registerEntryRenderer">,
): void {
	// A display-only CustomEntry (not a CustomMessageEntry): it never enters the
	// main agent's LLM context and never steers the running turn, so the card can
	// be appended the instant the side question finishes — even mid-stream.
	pi.registerEntryRenderer<BtwMessageDetails>("pix-btw-answer", (entry, options, theme) => {
		const details = entry.data;
		if (!details) return undefined;
		const failed = Boolean(details.error);
		const statusGlyph = failed
			? theme.fg("error", icon("status.error"))
			: theme.fg("success", icon("status.ok"));
		const meta = dotJoin([
			details.model,
			details.thinkingLevel,
			formatDuration(details.durationMs),
			details.toolUses > 0 && `${details.toolUses} tools`,
		]);

		// A custom renderer bypasses Pi's default custom-message box, so provide
		// our own card. Use selectedBg rather than the generic custom-message
		// background: it is intentionally more prominent across Pi themes, which
		// keeps this isolated side thread visually distinct from the main thread.
		// Keep chrome as Text and render only the answer as Markdown; ANSI-styled
		// header text embedded inside Markdown can confuse wrapping and parsing.
		const card = new Box(1, 1, (text) => theme.bg("selectedBg", text));
		card.addChild(
			new Text(`${statusGlyph} ${theme.bold("BTW")} ${theme.fg("dim", `· ${meta}`)}`, 0, 0),
		);
		card.addChild(
			new Text(`${theme.fg("accent", "▐")} ${theme.fg("muted", details.question)}`, 0, 0),
		);
		card.addChild(new Spacer(1));

		if (failed) {
			card.addChild(new Text(theme.fg("error", details.error ?? "Unknown error"), 0, 0));
			return card;
		}

		// Reasoning is preserved but collapsed by default: shown only when the host
		// requests the expanded view, never discarded (see AGENTS.md §3).
		if (details.thinking) {
			if (options.expanded) {
				card.addChild(new Text(theme.fg("dim", theme.bold("Reasoning")), 0, 0));
				card.addChild(new Text(theme.fg("thinkingText", details.thinking), 0, 0));
				card.addChild(new Spacer(1));
			} else {
				card.addChild(new Text(theme.fg("dim", "› reasoning hidden — expand to view"), 0, 0));
				card.addChild(new Spacer(1));
			}
		}

		try {
			card.addChild(
				new Markdown(details.answer, 0, 0, getMarkdownTheme(), {
					color: (text) => theme.fg("customMessageText", text),
				}),
			);
		} catch {
			card.addChild(new Text(theme.fg("customMessageText", details.answer), 0, 0));
		}
		return card;
	});
}
