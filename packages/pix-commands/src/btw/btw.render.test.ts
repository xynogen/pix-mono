import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { captureRows, roleTheme, withUiFixture } from "../../../../scripts/ui-capture.ts";
import { type BtwMessageDetails, registerBtwRenderer } from "./render.ts";
import { type BtwWidgetJob, renderBtwWidget } from "./widget.ts";

// ponytail: capture the owned Box and real Text widget. No child session or provider runs.
test("captures BTW card and widget with fixed settings, clock, and spinner", async () => {
	const fixture = await withUiFixture({ hostTheme: true });
	try {
		let renderer!: (
			entry: unknown,
			options: unknown,
			theme: unknown,
		) => { render(width: number): string[] };
		registerBtwRenderer({
			registerEntryRenderer: (_name: string, callback: typeof renderer) => {
				renderer = callback;
			},
		} as unknown as ExtensionAPI);
		const theme = roleTheme();
		const output: string[] = [];
		const details: BtwMessageDetails = {
			question: "Why does this file need a lock?",
			answer: "## Answer\n\n- **Read** the file.\n- Use `mutex`.",
			thinking: "The writer and reader share the file.",
			model: "Selected model",
			thinkingLevel: "high",
			durationMs: 2_100,
			toolUses: 2,
		};
		for (const [label, data, expanded] of [
			["markdown-hidden", details, false],
			["reasoning-expanded", details, true],
			["error", { ...details, error: "Provider unavailable" }, false],
			[
				"long-question",
				{
					...details,
					question: "Explain the lock and the write order. ".repeat(5),
					thinking: "",
					answer: "Because.",
				},
				false,
			],
		] as const) {
			output.push(
				`card:${label}`,
				...captureRows(renderer({ data }, { expanded }, theme), {
					width: 80,
					surface: "host-self",
				}),
			);
		}
		const now = 200_000_000;
		const job = (overrides: Partial<BtwWidgetJob>): BtwWidgetJob => ({
			id: 7,
			model: "Selected model",
			status: "running",
			startedAt: now - 2_100,
			activeTools: [],
			text: "Reading auth.ts",
			toolUses: 2,
			turnCount: 1,
			outputTokens: 42,
			contextUsage: null,
			...overrides,
		});
		for (const [label, jobs] of [
			["empty", []],
			["running", [job({ activeTools: ["read", "grep"] })]],
			[
				"mixed",
				[
					job({}),
					job({ id: 8, status: "completed", completedAt: now }),
					job({ id: 9, status: "error", completedAt: now, error: "offline" }),
					job({ id: 10, status: "stopped", completedAt: now }),
				],
			],
			["finished", [job({ status: "completed", completedAt: now })]],
			["expired", [job({ status: "completed", completedAt: now - 31_000 })]],
			["overflow", Array.from({ length: 20 }, (_, i) => job({ id: i + 1 }))],
		] as const) {
			const component = {
				render: (width: number) =>
					new Text(
						renderBtwWidget([...jobs], theme, 0, now, width, 10_000).join("\n"),
						0,
						0,
					).render(width),
			};
			// Empty Text renders a blank row. The host omits the widget when jobs are not visible.
			const rows =
				jobs.length && label !== "expired"
					? captureRows(component, { width: 80, surface: "component" })
					: renderBtwWidget([...jobs], theme, 0, now, 80, 10_000);
			output.push(`widget:${label}`, ...rows);
			if (label === "overflow") expect(rows).toHaveLength(12);
		}
		expect(output.join("\n")).toMatchSnapshot();
	} finally {
		await fixture.restore();
	}
});
