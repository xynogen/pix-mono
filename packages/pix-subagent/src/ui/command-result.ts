/**
 * ui/command-result.ts — result card for a `/agent` run.
 *
 * A display-only CustomEntry, like the /btw card: it never enters the main agent's
 * LLM context and never steers the running turn, so it lands the moment the agent
 * finishes. The full result is kept; collapse only shortens the view.
 */

import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { Box, getMarkdownTheme, Markdown, Spacer, Text } from "@xynogen/pix-pretty/tui";
import { clickToggle, dotJoin, pluralize } from "@xynogen/pix-pretty/utils";
import { formatDuration } from "@xynogen/pix-pretty/widget-format";
import type { ExtensionAPI } from "@xynogen/pix-runtime/host";
import type { AgentRecord, TerminalAgentStatus } from "../types.ts";

export const COMMAND_RESULT_TYPE = "pix-agent-result";
/** Result lines shown before the card collapses the rest behind a click. */
const PREVIEW_LINES = 20;

export interface CommandResultDetails {
	id: string;
	type: string;
	prompt: string;
	status: TerminalAgentStatus;
	model?: string;
	durationMs: number;
	toolUses: number;
	result: string;
	error?: string;
}

export function commandResultDetails(record: AgentRecord): CommandResultDetails {
	return {
		id: record.id,
		type: record.type,
		prompt: record.description,
		status: record.status as TerminalAgentStatus,
		model: record.invocation?.modelName,
		durationMs: (record.completedAt ?? Date.now()) - record.startedAt,
		toolUses: record.toolUses,
		result: record.result?.trim() ?? "",
		error: record.error,
	};
}

export function registerCommandResultRenderer(
	pi: Pick<ExtensionAPI, "registerEntryRenderer">,
): void {
	pi.registerEntryRenderer<CommandResultDetails>(COMMAND_RESULT_TYPE, (entry, options, theme) => {
		const d = entry.data;
		if (!d) return undefined;
		const ok = d.status === "completed" || d.status === "steered";
		const glyph = ok
			? theme.fg("success", icon("status.ok"))
			: theme.fg(d.status === "error" ? "error" : "warning", icon("status.error"));
		const meta = dotJoin([
			d.id,
			d.type !== "general" && d.type,
			d.model,
			formatDuration(d.durationMs, "btw"),
			d.toolUses > 0 && `${d.toolUses} tools`,
			!ok && d.status,
		]);
		const lines = d.result.split("\n");
		const cut = lines.length > PREVIEW_LINES;

		const build = (expanded: boolean) => {
			const card = new Box(1, 1, (text) => theme.bg("selectedBg", text));
			card.addChild(
				new Text(`${glyph} ${theme.bold("AGENT")} ${theme.fg("muted", `· ${meta}`)}`, 0, 0),
			);
			card.addChild(new Text(`${theme.fg("accent", "▐")} ${theme.fg("dim", d.prompt)}`, 0, 0));
			card.addChild(new Spacer(1));
			if (d.error) card.addChild(new Text(theme.fg("error", d.error), 0, 0));
			const body = expanded || !cut ? d.result : lines.slice(0, PREVIEW_LINES).join("\n");
			if (body) {
				try {
					card.addChild(
						new Markdown(body, 0, 0, getMarkdownTheme(), {
							color: (text) => theme.fg("customMessageText", text),
						}),
					);
				} catch {
					card.addChild(new Text(theme.fg("customMessageText", body), 0, 0));
				}
			} else if (!d.error) card.addChild(new Text(theme.fg("muted", "No output."), 0, 0));
			if (cut && !expanded)
				card.addChild(
					new Text(
						theme.fg(
							"muted",
							`… ${pluralize(lines.length - PREVIEW_LINES, "more line")} — click or expand to view`,
						),
						0,
						0,
					),
				);
			return card;
		};
		return cut ? clickToggle(options.expanded, build) : build(options.expanded);
	});
}
