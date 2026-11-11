import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { fadeLine, fadeText } from "@xynogen/pix-pretty/text";
import {
	mixColors,
	stripTerminalSequences,
	type Theme,
	visibleWidth,
} from "@xynogen/pix-pretty/tui";
import { humanUptime, type ProcMeta, procLabel, statusWord } from "./format.ts";

export function processRow(m: ProcMeta, now: number, width: number, theme: Theme): string {
	if (width <= 0) return "";
	const paint = (text: string, fade: number) =>
		fade === 0
			? theme.fg("dim", text)
			: theme.style(text, { fg: mixColors(theme.colors.dim, theme.colors.muted, fade) });
	const timer = humanUptime(now - m.startTime);
	const timerWidth = visibleWidth(timer);
	const badge = theme.fg("muted", timer);
	if (width < timerWidth + 4) return fadeLine(badge, width, paint);

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
	const prefix = `${chips}${separator}${fadeText(identity, 24, (t, f) => (f === 0 ? theme.fg("accent", t) : theme.style(t, { fg: mixColors(theme.colors.accent, theme.colors.muted, f) })))}${separator}`;
	const metadata = badge;
	const metadataWidth = visibleWidth(metadata);
	const available = width - metadataWidth - 1;
	const prefixWidth = visibleWidth(prefix);
	const label = stripTerminalSequences(procLabel({ command: m.command }))
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const body =
		prefixWidth >= available
			? fadeLine(prefix, available, paint)
			: prefix + fadeText(label, available - prefixWidth, paint);
	const gap = " ".repeat(Math.max(1, width - metadataWidth - visibleWidth(body)));
	return `${body}${gap}${metadata}`;
}
