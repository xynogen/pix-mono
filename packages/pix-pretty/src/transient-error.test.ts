import { describe, expect, jest, test } from "bun:test";
import {
	rgbColor,
	stripTerminalSequences,
	styleText,
	type TextStyle,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { roleTheme, semanticRow } from "../../../scripts/ui-capture.ts";
import {
	showTransientError,
	showTransientMessage,
	TRANSIENT_ERROR_TTL_MS,
} from "./transient-error.ts";

type WidgetFactory = (
	tui: unknown,
	theme: { fg: (_color: string, text: string) => string },
) => { render(width: number): string[]; invalidate(): void };

type WidgetCall = {
	key: string;
	content: WidgetFactory | undefined;
	options?: { placement?: "aboveEditor" | "belowEditor" };
};

function makeUi() {
	const calls: WidgetCall[] = [];
	return {
		calls,
		ui: {
			setWidget(key: string, content: WidgetFactory | undefined, options?: WidgetCall["options"]) {
				calls.push({ key, content, options });
			},
		},
	};
}

describe("showTransientError", () => {
	test("renders a top rule and one bounded error row above the editor", () => {
		jest.useFakeTimers();
		try {
			const { ui, calls } = makeUi();
			showTransientError(ui, "cache refresh failed");

			expect(calls).toHaveLength(1);
			expect(calls[0]?.options).toEqual({ placement: "aboveEditor" });
			const component = calls[0]?.content?.({}, { fg: (_color, text) => text });
			const lines = component?.render(80) ?? [];
			expect(lines).toHaveLength(2);
			expect(lines[0]).toMatch(/^[─-]/); // top rule
			expect(lines[1]).toMatch(/Runtime +│ error · cache refresh failed$/);
			for (const line of lines) {
				expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
			}
		} finally {
			jest.useRealTimers();
		}
	});

	test("renders warning and info messages with matching labels and colors", () => {
		jest.useFakeTimers();
		try {
			const { ui, calls } = makeUi();
			showTransientMessage(ui, "using cached metadata", "warning");
			const warningColors: string[] = [];
			const warning = calls.at(-1)?.content?.(
				{},
				{
					fg: (color, text) => {
						warningColors.push(color);
						return text;
					},
				},
			);
			expect(warning?.render(80)[1]).toMatch(/Runtime +│ warning · using cached metadata$/);
			expect(warningColors).toContain("warning");

			showTransientMessage(ui, "configuration reloaded", "info");
			const infoColors: string[] = [];
			const info = calls.at(-1)?.content?.(
				{},
				{
					fg: (color, text) => {
						infoColors.push(color);
						return text;
					},
				},
			);
			expect(info?.render(80)[1]).toMatch(/Runtime +│ info · configuration reloaded$/);
			expect(infoColors).toContain("accent");
		} finally {
			jest.useRealTimers();
		}
	});

	test("preserves semantic hierarchy, fades only overflow, and bounds every terminal width", () => {
		jest.useFakeTimers();
		try {
			const { ui, calls } = makeUi();
			showTransientMessage(
				ui,
				"cache \x1b[31mrefresh\x1b[0m failed\n界e\u0301🙂".repeat(20),
				"warning",
			);
			const colors = { dim: rgbColor(180, 180, 180), muted: rgbColor(70, 70, 70) };
			const theme = Object.assign(Object.create(roleTheme()), {
				colors,
				style: (text: string, style: TextStyle) => styleText(text, style, "truecolor"),
				bg() {
					throw new Error("Transient widget must not paint a background");
				},
			});
			const widget = calls.at(-1)!.content!({}, theme);
			const row = widget.render(80)[1]!;
			expect(stripTerminalSequences(row)).toMatch(/Runtime +│ warning · cache refresh failed/);
			expect(row).toContain("\x1b[38;2;70;70;70m");
			for (let width = 0; width <= 120; width++) {
				for (const line of widget.render(width))
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
			showTransientMessage(ui, "configuration reloaded", "info");
			const short = calls.at(-1)!.content!({}, theme).render(80)[1]!;
			expect(semanticRow(short)).toMatch(
				/<toolTitle>.+ Runtime +<\/toolTitle><muted> │ <\/muted><accent>info<\/accent><muted> · <\/muted><dim>configuration reloaded<\/dim>/,
			);
		} finally {
			jest.useRealTimers();
		}
	});

	test("clears after 30 seconds", () => {
		jest.useFakeTimers();
		try {
			const { ui, calls } = makeUi();
			showTransientError(ui, "offline");

			jest.advanceTimersByTime(TRANSIENT_ERROR_TTL_MS - 1);
			expect(calls).toHaveLength(1);
			jest.advanceTimersByTime(1);
			expect(calls.at(-1)?.content).toBeUndefined();
		} finally {
			jest.useRealTimers();
		}
	});

	test("newest error replaces the row and owns the timeout", () => {
		jest.useFakeTimers();
		try {
			const { ui, calls } = makeUi();
			showTransientError(ui, "first");
			jest.advanceTimersByTime(20_000);
			showTransientError(ui, "second");
			jest.advanceTimersByTime(10_000);
			expect(calls).toHaveLength(2);
			jest.advanceTimersByTime(20_000);
			expect(calls.at(-1)?.content).toBeUndefined();
		} finally {
			jest.useRealTimers();
		}
	});
});
