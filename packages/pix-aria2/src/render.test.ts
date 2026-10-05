import { describe, expect, test } from "bun:test";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { COLLAPSED_TOOL_GLYPH } from "@xynogen/pix-pretty/utils";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";
import registerDownload from "./index.ts";

type Component = { render(width: number): string[] };
type Tool = {
	renderCall(args: unknown, theme: unknown, context: unknown): Component;
	renderResult(result: unknown, options: unknown, theme: unknown, context: unknown): Component;
};

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function tool(): Tool {
	let registered: Tool | undefined;
	registerDownload({
		on() {},
		registerTool(value: Tool) {
			registered = value;
		},
	} as never);
	if (!registered) throw new Error("download tool was not registered");
	return registered;
}

test("W1 capture: registered download call and self results", async () => {
	const fixture = await withUiFixture();
	try {
		const registered = tool();
		const theme = roleTheme();
		expect(
			captureRows(
				registered.renderCall({ action: "add", url: "https://example.test/file.iso" }, theme, {}),
				{ width: 80, surface: "component" },
			),
		).toMatchSnapshot("call");
		for (const [name, value, expanded, isPartial, isError] of [
			[
				"compact success",
				result(true, ["dl-fixed-otter-42 queued", "https://example.test/file.iso"]),
				false,
				false,
				false,
			],
			["compact error", result(false, [], "aria2c not found"), false, false, true],
			[
				"expanded success",
				result(true, ["dl-fixed-otter-42 queued", "second line"]),
				true,
				false,
				false,
			],
			["expanded error", result(false, [], "aria2c not found"), true, false, true],
			["partial", result(true, ["Waiting for RPC", "Still connecting"]), false, true, false],
			[
				"fallback",
				{ content: [{ type: "text", text: "no active downloads" }] },
				false,
				false,
				false,
			],
		] as const) {
			const component = registered.renderResult(value, { expanded, isPartial }, theme, {
				expanded,
				isError,
			});
			expect(captureRows(component, { width: 80, surface: "host-self" })).toMatchSnapshot(name);
		}
	} finally {
		await fixture.restore();
	}
});

function result(ok: boolean, lines: string[], error?: string) {
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: { _type: "downloadResult", action: "add", ok, lines, error },
		isError: !ok,
	};
}

describe("download renderer", () => {
	test("uses compact output with a dashed close when collapsed", () => {
		const rendered = tool()
			.renderResult(
				result(true, ["dl-sleek-pika-63 queued — https://example.com/archlinux.iso"]),
				{ expanded: false, isPartial: false },
				plainTheme,
				{ expanded: false, isError: false },
			)
			.render(160);

		expect(rendered[0]).toContain(icon("update"));
		expect(rendered[0]).toContain("dl-sleek-pika-63 queued");
		expect(rendered.at(-1)).toBe("- ".repeat(80));
	});

	test("shows errors in the compact row", () => {
		const rendered = tool()
			.renderResult(
				result(false, [], "aria2c not found"),
				{ expanded: false, isPartial: false },
				plainTheme,
				{ expanded: false, isError: true },
			)
			.render(80)
			.join("\n");

		expect(rendered).toContain(COLLAPSED_TOOL_GLYPH.error);
		expect(rendered).toContain("aria2c not found");
	});

	test("closes expanded success and error details with status-colored dashes", () => {
		const theme = {
			fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
			bold: (text: string) => text,
		};
		const host = tool();
		const success = host
			.renderResult(result(true, ["queued"]), { expanded: true, isPartial: false }, theme, {
				expanded: true,
				isError: false,
			})
			.render(20);
		const error = host
			.renderResult(result(false, [], "failed"), { expanded: true, isPartial: false }, theme, {
				expanded: true,
				isError: true,
			})
			.render(20);

		expect(success[0]?.trimEnd()).toBe("queued");
		expect(success.at(-1)).toBe(`<success>${"- ".repeat(10)}</success>`);
		expect(error[0]?.trimEnd()).toBe("failed");
		expect(error.at(-1)).toBe(`<error>${"- ".repeat(10)}</error>`);
	});
});
