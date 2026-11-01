import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { icon } from "./icon-catalog.ts";
import { rule, widgetActivityRow, widgetTitle } from "./utils.ts";

export const TRANSIENT_ERROR_TTL_MS = 30_000;
const WIDGET_KEY = "pix-transient-error";
const timers = new WeakMap<object, ReturnType<typeof setTimeout>>();

type TransientMessageTheme = {
	fg(
		color:
			| "error"
			| "warning"
			| "accent"
			| "success"
			| "toolTitle"
			| "dim"
			| "muted"
			| "borderMuted",
		text: string,
	): string;
	colors?: Pick<Theme["colors"], "dim" | "muted">;
	style?: Theme["style"];
};

export type TransientMessageLevel = "error" | "warning" | "info";

type WidgetFactory = (
	tui: unknown,
	theme: TransientMessageTheme,
) => { render(width: number): string[]; invalidate(): void };

export type TransientErrorUI = {
	setWidget(
		key: string,
		content: WidgetFactory | undefined,
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
};

/** Show newest runtime message above the editor (on top of the prompt bar), then remove it after 30 seconds. */
export function showTransientMessage(
	ui: TransientErrorUI,
	message: string,
	level: TransientMessageLevel = "error",
): void {
	const previous = timers.get(ui);
	if (previous) clearTimeout(previous);

	ui.setWidget(
		WIDGET_KEY,
		(_tui, theme) => {
			const detail = stripTerminalSequences(message)
				.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
				.replace(/\s+/g, " ")
				.trim();
			const fadeTheme = {
				fg: theme.fg.bind(theme),
				style: theme.style?.bind(theme),
				colors: theme.colors && { dim: theme.colors.dim, customMessageBg: theme.colors.muted },
			};
			return {
				render(width: number) {
					if (width < 1) return [];
					const color = level === "info" ? "accent" : level;
					const glyph = icon(
						level === "error"
							? "status.error"
							: level === "warning"
								? "status.warn"
								: "status.active",
					);
					const prefix = widgetTitle(theme, glyph, "Runtime") + theme.fg(color, level);
					return [
						rule(width, (glyphs) => theme.fg("borderMuted", glyphs)),
						widgetActivityRow(fadeTheme, prefix, detail, width),
					];
				},
				invalidate() {},
			};
		},
		{ placement: "aboveEditor" },
	);

	const timer = setTimeout(() => {
		if (timers.get(ui) !== timer) return;
		timers.delete(ui);
		ui.setWidget(WIDGET_KEY, undefined);
	}, TRANSIENT_ERROR_TTL_MS);
	timer.unref?.();
	timers.set(ui, timer);
}

/** Error-level convenience wrapper. */
export function showTransientError(ui: TransientErrorUI, message: string): void {
	showTransientMessage(ui, message, "error");
}
