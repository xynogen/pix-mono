import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { makeTheme } from "@xynogen/pix-pretty/test-utils";
import { withUiFixture } from "../../../scripts/ui-capture.ts";
import { makeRenderResult } from "./render.ts";

test("renders successful web content as Markdown without changing the model text", async () => {
	const fixture = await withUiFixture({ hostTheme: true });
	try {
		const content = "# Guide\n\n- [Open](https://example.com)\n- **Read**";
		const result = { content: [{ type: "text" as const, text: content }] };
		const renderer = makeRenderResult();
		const ctx = {
			lastComponent: undefined,
			isError: false,
			state: {},
			expanded: true,
			invalidate() {},
		};
		const view = renderer(
			result as AgentToolResult<unknown>,
			{ isPartial: false, expanded: true },
			makeTheme() as Theme,
			ctx,
		);
		const display = view.render(80).join("\n");
		expect(display).toContain("Guide");
		expect(display).toContain("Open");
		expect(display).toContain("Read");
		expect(display).not.toContain("**Read**");
		expect(result.content[0]?.text).toBe(content);
	} finally {
		await fixture.restore();
	}
});

test("shows a bounded Markdown preview and the full content when expanded", async () => {
	const fixture = await withUiFixture({ hostTheme: true });
	try {
		const content = [
			"# Results",
			...Array.from({ length: 40 }, (_, index) => `- **Item ${index}**`),
		].join("\n");
		const renderer = makeRenderResult();
		const result = {
			content: [{ type: "text" as const, text: content }],
		} as AgentToolResult<unknown>;
		const theme = makeTheme() as Theme;
		const ctx = {
			lastComponent: undefined,
			isError: false,
			state: {},
			expanded: false,
			invalidate() {},
		};
		const preview = stripVTControlCharacters(
			renderer(result, { isPartial: false, expanded: false }, theme, ctx).render(80).join("\n"),
		);
		const full = stripVTControlCharacters(
			renderer(result, { isPartial: false, expanded: true }, theme, ctx).render(80).join("\n"),
		);
		expect(preview).toContain("9 more lines");
		expect(preview).toContain("Item 30");
		expect(full).toContain("Item 39");
		expect(result.content[0]).toEqual({ type: "text", text: content });
	} finally {
		await fixture.restore();
	}
});
