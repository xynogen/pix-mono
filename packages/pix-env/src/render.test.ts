import { expect, test } from "bun:test";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import register from "./extension.ts";

test("env renderer hides disclosed values even on expansion and summarizes types", () => {
	let tool: any;
	register({
		events: createEventBus(),
		on() {},
		registerTool(value: any) {
			tool = value;
		},
	} as unknown as ExtensionAPI);
	const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
	for (const expanded of [false, true]) {
		const result = {
			content: [{ type: "text", text: "TOKEN=fixture-secret\nmultiline-secret" }],
			details: { action: "read", revealed: ["TOKEN"] },
		};
		const rows = tool
			.renderResult(result, { expanded }, theme, { state: {}, expanded, invalidate() {} })
			.render(100)
			.join("\n");
		expect(rows).toContain("TOKEN");
		expect(rows).toContain("value hidden");
		expect(rows).not.toContain("fixture-secret");
		expect(rows).not.toContain("multiline-secret");
	}
	const types = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`KEY_${i}`, "string"]));
	const value = { content: [], details: { action: "info", count: 20, types } };
	const preview = tool
		.renderResult(value, { expanded: false }, theme, {
			state: {},
			expanded: false,
			invalidate() {},
		})
		.render(100)
		.join("\n");
	expect(preview).toContain("20 variables");
	expect(preview).toContain("8 more variables");
	expect(preview).not.toContain("KEY_19");
	const full = tool
		.renderResult(value, { expanded: true }, theme, { state: {}, expanded: true, invalidate() {} })
		.render(100)
		.join("\n");
	expect(full).toContain("KEY_19");
	const denied = tool
		.renderResult(
			{
				content: [{ type: "text", text: "Denied" }],
				details: { action: "read", revealed: [], outcome: "denied" },
			},
			{ expanded: false },
			{ ...theme, fg: (role: string, text: string) => `<${role}>${text}</${role}>` },
			{ state: {}, expanded: false, invalidate() {} },
		)
		.render(100)
		.join("\n");
	expect(denied).toContain("<warning>");
	expect(denied).toContain("denied");
});
