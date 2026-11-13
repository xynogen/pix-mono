import { expect, test } from "bun:test";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { collapseSection } from "@xynogen/pix-runtime/sections";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";
import register from "../src/extension.ts";

test("env renderer hides disclosed values even on expansion and summarizes types", async () => {
	const fixture = await withUiFixture();
	try {
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
			await fixture.runtime.update(collapseSection, { enabled: true });
			for (const width of [40, 80]) {
				const component = tool.renderResult(result, { expanded }, roleTheme(), {
					state: { collapsed: true },
					expanded,
					invalidate() {},
				});
				const captured = captureRows(component, { width, surface: "host-self" });
				expect(captured.join("\n")).not.toMatch(/fixture-secret|multiline-secret/);
				if (!expanded) expect(component.render(width)).toHaveLength(1);
				expect(captured).toMatchSnapshot(`read ${expanded ? "expanded" : "collapsed"} ${width}`);
			}
			await fixture.runtime.update(collapseSection, { enabled: false });
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
		// The call row carries the title; the open body lists variables without repeating it.
		expect(preview).not.toContain("read_env · info");
		expect(preview).toContain("8 more variables");
		expect(preview).not.toContain("KEY_19");
		const full = tool
			.renderResult(value, { expanded: true }, theme, {
				state: {},
				expanded: true,
				invalidate() {},
			})
			.render(100)
			.join("\n");
		expect(full).toContain("KEY_19");
		for (const expanded of [false, true]) {
			const component = tool.renderResult(value, { expanded }, roleTheme(), {
				state: {},
				expanded,
				invalidate() {},
			});
			expect(captureRows(component, { width: 80, surface: "host-self" })).toMatchSnapshot(
				`types ${expanded ? "expanded" : "preview"}`,
			);
		}
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
		const deniedComponent = tool.renderResult(
			{
				content: [{ type: "text", text: "Denied" }],
				details: { action: "read", revealed: [], outcome: "denied" },
			},
			{ expanded: false },
			roleTheme(),
			{ state: {}, expanded: false, invalidate() {} },
		);
		expect(captureRows(deniedComponent, { width: 40, surface: "host-self" })).toMatchSnapshot(
			"denied",
		);
	} finally {
		await fixture.restore();
	}
});
