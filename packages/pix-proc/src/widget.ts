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
	const badge = theme.fg("muted", timer);
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
	const separator = theme.fg("muted", " · ");
	const chips = [
		theme.fg(role, `${glyph} ${statusWord(m)}`),
		...(m.logError ? [theme.fg("error", "log error")] : []),
		...(m.capped ? [theme.fg("warning", "capped")] : []),
	].join(separator);
	const identity = stripTerminalSequences(
		procLabel({ command: (m.name || m.handle).replace(/\s+/g, " ") }),
	).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
	const prefix = `${chips}${separator}${theme.fg("accent", truncateToWidth(identity, 24, "…"))}${separator}`;
	const metadata = badge;
	const metadataWidth = visibleWidth(metadata);
	const available = width - metadataWidth - 2;
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
							fg: mixColors(theme.colors.dim, theme.colors.muted, fade),
						}),
			);
	}
	const gap = " ".repeat(width - metadataWidth - visibleWidth(body) - 1);
	return `${body}${gap}${metadata} `;
}
