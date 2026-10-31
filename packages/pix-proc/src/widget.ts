import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	mixColors,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { fadeText } from "@xynogen/pix-pretty/text";
import { humanUptime, type ProcMeta, procLabel, statusWord } from "./format.ts";

export function processRow(m: ProcMeta, now: number, width: number, theme: Theme): string {
	if (width <= 0) return "";
	const timer = ` ${humanUptime(now - m.startTime)} `;
	const timerWidth = visibleWidth(timer);
	const badge = theme.bg("selectedBg", theme.fg("muted", timer));
	if (width < timerWidth + 4) return truncateToWidth(badge, width, "");

	const role = m.logError
		? "error"
		: m.status === "running"
			? "accent"
			: m.status === "killed"
				? "warning"
				: m.exitCode === 0
					? "success"
					: "error";
	const glyph = icon(
		m.logError || (m.status === "exited" && m.exitCode !== 0)
			? "status.error"
			: m.status === "running"
				? "status.running"
				: m.status === "killed"
					? "status.blocked"
					: "status.ok",
	);
	const chips = [
		theme.bg("selectedBg", theme.fg(role, ` ${statusWord(m)} `)),
		...(m.capped ? [theme.bg("selectedBg", theme.fg("warning", " capped "))] : []),
		...(m.logError ? [theme.bg("selectedBg", theme.fg("error", " log error "))] : []),
	].join(" ");
	const identity = stripTerminalSequences(
		procLabel({ command: (m.name || m.handle).replace(/\s+/g, " ") }),
	).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
	const prefix = `${theme.fg(role, glyph)} ${theme.fg("accent", truncateToWidth(identity, 24, "…"))}  `;
	const metadata =
		visibleWidth(chips) + timerWidth + visibleWidth(prefix) + 5 < width
			? `${chips} ${badge}`
			: badge;
	const metadataWidth = visibleWidth(metadata);
	const available = width - metadataWidth - 4;
	const prefixWidth = visibleWidth(prefix);
	const label = stripTerminalSequences(procLabel({ command: m.command }))
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	let body: string;
	if (prefixWidth >= available) {
		body = truncateToWidth(prefix, available, "…");
	} else {
		body =
			prefix +
			fadeText(label, available - prefixWidth, (text, fade) =>
				fade === 0
					? theme.fg("dim", text)
					: theme.style(text, {
							fg: mixColors(theme.colors.dim, theme.colors.customMessageBg, fade),
						}),
			);
	}
	const gap = " ".repeat(width - metadataWidth - visibleWidth(body) - 3);
	return (
		theme.bg(
			"customMessageBg",
			`  ${body}${gap}`.replaceAll("\x1b[49m", theme.getBgAnsi("customMessageBg")),
		) +
		metadata +
		theme.bg("customMessageBg", " ")
	);
}
