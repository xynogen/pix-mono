import { expect, test } from "bun:test";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";
import {
	COMMAND_RESULT_TYPE,
	type CommandResultDetails,
	registerCommandResultRenderer,
} from "../src/ui/command-result.ts";

// ponytail: capture the owned card only. No agent session or provider runs.
test("captures /agent result card: done, long collapsed and expanded, error, empty", async () => {
	const fixture = await withUiFixture({ hostTheme: true });
	try {
		let renderer!: (
			entry: unknown,
			options: unknown,
			theme: unknown,
		) => { render(width: number): string[] };
		registerCommandResultRenderer({
			registerEntryRenderer: (name: string, callback: typeof renderer) => {
				expect(name).toBe(COMMAND_RESULT_TYPE);
				renderer = callback;
			},
		} as never);
		const theme = roleTheme();
		const base: CommandResultDetails = {
			id: "agent-calm-otter-12",
			type: "Explore",
			prompt: "map the repo layout",
			status: "completed",
			model: "model one",
			durationMs: 64_000,
			toolUses: 9,
			result: "## Layout\n\n- `packages/` holds every extension.\n- `scripts/` holds CI checks.",
		};
		const long = Array.from({ length: 26 }, (_, i) => `line ${i + 1}`).join("\n");
		const output: string[] = [];
		for (const [label, data, expanded] of [
			["done", base, false],
			["long-collapsed", { ...base, type: "general", result: long }, false],
			["long-expanded", { ...base, type: "general", result: long }, true],
			["error", { ...base, status: "error", result: "", error: "Provider unavailable" }, false],
			["stopped-empty", { ...base, status: "stopped", result: "" }, false],
		] as const) {
			output.push(
				`card:${label}`,
				...captureRows(renderer({ data }, { expanded }, theme), {
					width: 80,
					surface: "host-self",
				}),
			);
		}
		const text = output.join("\n");
		// Collapse hides rows from view only; expanding shows every result line.
		expect(text).toContain("6 more lines");
		expect(text.split("card:long-expanded")[1]).toContain("line 26");
		expect(text).toMatchSnapshot();
	} finally {
		await fixture.restore();
	}
});
