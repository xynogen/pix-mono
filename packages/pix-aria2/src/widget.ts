import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { fadeText } from "@xynogen/pix-pretty/text";
import { mixColors, type Theme, truncateToWidth, visibleWidth } from "@xynogen/pix-pretty/tui";
import { rule, widgetTitle } from "@xynogen/pix-pretty/utils";
import { type DlStatus, downloadName, fraction, progressStats } from "./format.ts";

type WidgetTheme = Pick<Theme, "fg"> &
	Partial<Pick<Theme, "style">> & {
		colors?: Pick<Theme["colors"], "dim" | "muted">;
	};

export function renderDownloadWidget(
	downloads: DlStatus[],
	width: number,
	theme: WidgetTheme,
): string[] {
	if (!downloads.length || width < 1) return [];
	const stats = downloads.map(progressStats);
	const statsWidth = Math.max(...stats.map(visibleWidth));
	return [
		rule(width, (text) => theme.fg("borderMuted", text)),
		...downloads.map((download, i) => {
			const complete =
				download.status === "complete" ||
				(Number(download.totalLength) > 0 && fraction(download) >= 1);
			const failed = download.status === "error";
			const role = failed ? "error" : complete ? "success" : "accent";
			const prefix = widgetTitle(theme, i === 0 ? icon("update") : "", i === 0 ? "Download" : "");
			const prefixWidth = visibleWidth(prefix);
			let tail = (stats[i] ?? "").padStart(statsWidth);
			if (visibleWidth(tail) > width - prefixWidth - 8)
				tail = Number(download.totalLength) > 0 ? `${Math.round(fraction(download) * 100)}%` : "?";
			const available = width - prefixWidth - visibleWidth(tail) - 2;
			if (available < 1)
				return truncateToWidth(`${prefix}${theme.fg(role, tail.trim())}`, width, "");
			const barWidth = available >= 14 ? Math.min(24, Math.floor(available / 3)) : 0;
			const labelWidth = available - (barWidth ? barWidth + 2 : 0);
			const paint = (text: string, fade: number) =>
				fade && theme.colors && theme.style
					? theme.style(text, {
							fg: mixColors(theme.colors.dim, theme.colors.muted, fade),
						})
					: theme.fg(fade ? "muted" : "dim", text);
			const name = downloadName(download);
			const url = download.files?.[0]?.uris?.[0]?.uri ?? "";
			const urlWidth = url && labelWidth >= 20 ? Math.floor((labelWidth - 3) * 0.45) : 0;
			const label = urlWidth
				? fadeText(name, labelWidth - urlWidth - 3, paint) +
					theme.fg("muted", " · ") +
					fadeText(url, urlWidth, paint)
				: fadeText(name, labelWidth, paint);
			const filled = Math.round(fraction(download) * barWidth);
			const bar = barWidth
				? theme.fg(role, "█".repeat(filled)) + paint("░".repeat(barWidth - filled), 0.65)
				: "";
			const body =
				prefix + label + " ".repeat(labelWidth - visibleWidth(label)) + (bar ? `  ${bar}` : "");
			return `${body}  ${theme.fg("muted", tail)}`;
		}),
	];
}
