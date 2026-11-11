import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { fadeLine, fadeText } from "@xynogen/pix-pretty/text";
import { mixColors, type Theme, visibleWidth } from "@xynogen/pix-pretty/tui";
import { dotJoin, rule, widgetTitle } from "@xynogen/pix-pretty/utils";
import type { TodoItem } from "./todo.ts";

export function renderTodoWidget(
	items: TodoItem[],
	ordered: boolean,
	width: number,
	theme: Theme,
): string[] {
	if (width < 1 || items.length === 0) return [];
	const done = items.filter((item) => item.status === "done").length;
	const active = items.filter((item) => item.status === "in_progress");
	const blocked = items.filter((item) => item.status === "blocked");
	const current = active[0] ?? blocked[0] ?? items.find((item) => item.status === "pending");
	const role =
		current?.status === "blocked"
			? "error"
			: current?.status === "in_progress"
				? "accent"
				: current
					? "muted"
					: "success";
	const position =
		ordered && current
			? `${items.indexOf(current) + 1}/${items.length}`
			: `${done}/${items.length} done`;
	const status =
		current?.status === "in_progress" ? "in progress" : (current?.status ?? "complete");
	const prefix =
		widgetTitle(theme, icon("status.ok"), "Todo") +
		dotJoin(
			[
				theme.fg(role, status),
				active.length > 1 && theme.fg("muted", `${active.length} active`),
				blocked.length > (current?.status === "blocked" ? 1 : 0) &&
					theme.fg("error", `${blocked.length} blocked`),
			],
			(text) => theme.fg("muted", text),
		);
	const separator = theme.fg("muted", " · ");
	const metadata = separator + theme.fg("muted", position);
	const room = width - visibleWidth(prefix) - visibleWidth(metadata) - visibleWidth(separator);
	const paint = (text: string, fade: number) =>
		fade === 0
			? theme.fg("accent", text)
			: theme.style(text, { fg: mixColors(theme.colors.accent, theme.colors.muted, fade) });
	const task = current && room > 0 ? fadeText(current.text, room, paint) : "";
	const row = fadeLine(`${prefix}${task ? separator + task : ""}${metadata}`, width, paint);
	return [rule(width, (text) => theme.fg("borderMuted", text)), row];
}
