import type { Theme } from "@earendil-works/pi-coding-agent";
import { mixColors, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { fadeText } from "@xynogen/pix-pretty/text";
import { rule } from "@xynogen/pix-pretty/utils";
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
	const extra = [
		...(active.length > 1 ? [`${active.length} active`] : []),
		...(blocked.length && current?.status !== "blocked" ? [`${blocked.length} blocked`] : []),
		...(blocked.length > 1 && current?.status === "blocked" ? [`${blocked.length} blocked`] : []),
	].join(" · ");
	const prefix = `${theme.fg("accent", "Todo")}  ${theme.fg("muted", position)} · ${theme.fg(role, status)}${extra ? ` · ${theme.fg("muted", extra)}` : ""}`;
	const room = width - visibleWidth(prefix) - 2;
	const row =
		current && room > 0
			? `${prefix}  ${fadeText(current.text, room, (text, fade) =>
					fade === 0
						? theme.fg("dim", text)
						: theme.style(text, {
								fg: mixColors(theme.colors.dim, theme.colors.customMessageBg, fade),
							}),
				)}`
			: truncateToWidth(prefix, width, "…");
	return [rule(width, (text) => theme.fg("borderMuted", text)), row];
}
