/**
 * ui/notification.ts — subagent-notification custom message renderer.
 *
 * Terminal notifications stay on one physical line by default. Expansion adds
 * the bounded result preview and diagnostic retained in the message details.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { COLLAPSED_TOOL_GLYPH, padIcon } from "@xynogen/pix-pretty/utils";
import { formatContext, formatMs, formatSpeed, formatToolUses, formatTurns } from "../tools.ts";
import type { NotificationDetails } from "../types.ts";

type NotificationTheme = {
	fg(color: string, text: string): string;
	bold(text: string): string;
};

/** Format the permanent single-row summary for a terminal background agent. */
export function formatNotificationLine(d: NotificationDetails, theme: NotificationTheme): string {
	let marker: string;
	let statusText: string;
	switch (d.status) {
		case "completed":
			marker = theme.fg("success", padIcon("✓"));
			statusText = "completed";
			break;
		case "steered":
			marker = theme.fg("success", padIcon("✓"));
			statusText = "completed (steered)";
			break;
		case "stopped":
			marker = theme.fg("dim", padIcon("■"));
			statusText = "stopped";
			break;
		case "aborted":
			marker = theme.fg("warning", padIcon(COLLAPSED_TOOL_GLYPH.warning));
			statusText = "aborted";
			break;
		case "error":
			marker = theme.fg("error", padIcon("✗"));
			statusText = "error";
	}

	const parts: string[] = [];
	if (d.modelName) parts.push(theme.fg("muted", `[${d.modelName}]`));
	if (d.turnCount > 0) parts.push(theme.fg("dim", formatTurns(d.turnCount, d.maxTurns)));
	if (d.toolUses > 0) parts.push(theme.fg("dim", formatToolUses(d.toolUses)));
	const context = formatContext(d.contextUsage);
	if (context) parts.push(theme.fg("dim", context));
	const speed = formatSpeed(d.outputTokens ?? 0, d.streamingMs ?? d.durationMs);
	if (speed) parts.push(theme.fg("dim", speed));
	if (d.durationMs > 0) parts.push(theme.fg("dim", formatMs(d.durationMs)));

	let line = `${marker} ${theme.bold(d.description)}`;
	if (parts.length > 0)
		line += ` ${theme.fg("dim", "·")} ${parts.join(` ${theme.fg("dim", "·")} `)}`;
	line += ` ${theme.fg("dim", "·")} ${theme.fg(d.status === "error" ? "error" : "dim", statusText)}`;
	if (d.status === "error" && d.error) line += theme.fg("error", `: ${d.error.slice(0, 100)}`);
	return line;
}

/** Register the subagent-notification message renderer. */
export function registerNotificationRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer<NotificationDetails>(
		"subagent-notification",
		(message, { expanded }, theme) => {
			const details = message.details;
			if (!details) return undefined;

			let output = formatNotificationLine(details, theme);
			if (expanded) {
				for (const line of details.resultPreview.split("\n").slice(0, 30)) {
					output += `\n${theme.fg("dim", `  ${line}`)}`;
				}
				if (details.resultTruncated) {
					output += `\n${theme.fg("muted", "  … preview truncated; use agent_result for full output")}`;
				}
				if (details.error) output += `\n${theme.fg("error", `  ${details.error}`)}`;
			}

			return new Text(output, 0, 0);
		},
	);
}
