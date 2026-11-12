import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { COLLAPSED_TOOL_GLYPH } from "@xynogen/pix-pretty/utils";
import type { NotificationDetails } from "../src/types.ts";
import { formatNotificationLine, registerNotificationRenderer } from "../src/ui/notification.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function captureRenderer() {
	let renderer: ((message: unknown, options: unknown, theme: unknown) => unknown) | undefined;
	const pi = {
		registerMessageRenderer(_name: string, fn: typeof renderer) {
			renderer = fn;
		},
	} as unknown as ExtensionAPI;
	registerNotificationRenderer(pi);
	if (!renderer) throw new Error("notification renderer was not registered");
	return renderer;
}

function details(status: NotificationDetails["status"]): NotificationDetails {
	return {
		id: "abc123",
		description: "Explore authentication",
		status,
		modelName: "haiku",
		toolUses: 3,
		turnCount: 5,
		maxTurns: 8,
		contextUsage: { tokens: 12_400, contextWindow: 100_000, percent: 12.4 },
		outputTokens: 550,
		streamingMs: 10_000,
		durationMs: 12_000,
		error: status === "error" ? "provider unavailable" : undefined,
		resultPreview: "Found three references.\nSecond bounded preview line.",
		resultTruncated: true,
	};
}

function renderNotification(value: NotificationDetails, expanded: boolean): string {
	const component = captureRenderer()(
		{ details: value, content: value.resultPreview },
		{ expanded },
		theme,
	) as { render(width: number): string[] };
	return component.render(200).join("\n");
}

describe("terminal subagent notifications", () => {
	test("completed notification is one line by default", () => {
		const output = renderNotification(details("completed"), false);
		expect(output.split("\n")).toHaveLength(1);
		expect(output).toContain("Explore");
		expect(output).toContain("55 t/s");
	});

	test("uses primary status, secondary description, and tertiary metadata", () => {
		const taggedTheme = {
			fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
			bold: (text: string) => text,
		};
		const output = formatNotificationLine(details("completed"), taggedTheme);
		expect(output).toContain("<success>✓ </success>");
		expect(output).toContain("<dim>Explore authentication</dim>");
		expect(output).toContain("<muted>[haiku]</muted>");
		expect(output).toContain("<muted>55 t/s</muted>");
		expect(output).toContain("<success>completed</success>");
	});

	test("expanded notification shows the stored bounded preview", () => {
		const value = details("completed");
		const output = renderNotification(value, true);
		expect(output.split("\n").length).toBeGreaterThan(1);
		for (const line of value.resultPreview.split("\n")) expect(output).toContain(line);
		expect(output).toContain("preview truncated");
	});

	for (const [status, marker, label] of [
		["completed", COLLAPSED_TOOL_GLYPH.success, "completed"],
		["steered", COLLAPSED_TOOL_GLYPH.success, "completed (steered)"],
		["stopped", "■", "stopped"],
		["aborted", COLLAPSED_TOOL_GLYPH.warning, "aborted"],
		["error", COLLAPSED_TOOL_GLYPH.error, "error"],
	] as const) {
		test(`${status} notification uses one terminal summary row`, () => {
			const output = renderNotification(details(status), false);
			expect(output.split("\n")).toHaveLength(1);
			expect(output).toContain(marker);
			expect(output).toContain(label);
			expect(output).toContain("Explore authentication");
		});
	}

	test("expanded error includes the stored diagnostic", () => {
		const output = renderNotification(details("error"), true);
		expect(output).toContain("provider unavailable");
	});
});
