import { describe, expect, test } from "bun:test";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { COLLAPSED_TOOL_GLYPH } from "@xynogen/pix-pretty/utils";
import registerRunner from "./index.ts";

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
	registerRunner({
		on() {},
		registerTool(value: Tool) {
			registered = value;
		},
		registerCommand() {},
	} as never);
	if (!registered) throw new Error("proc tool was not registered");
	return registered;
}

function result(ok: boolean, lines: string[], error?: string) {
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: { _type: "procResult", action: "start", ok, lines, error },
		isError: !ok,
	};
}

describe("proc renderer", () => {
	test("wraps long commands with the shared parameter separator", () => {
		const lines = tool()
			.renderCall(
				{ action: "start", command: "npm run dev && echo a long command with several parameters" },
				plainTheme,
				{ state: {}, invalidate() {}, expanded: false },
			)
			.render(32);
		expect(lines[0]).toContain("proc start ·");
		expect(lines.length).toBeGreaterThan(2);
		expect(lines[1]).toMatch(/^ {2}/);
	});
	test("collapsed success shows the process glyph and a dashed close", () => {
		const rendered = tool()
			.renderResult(
				result(true, ["proc-swift-otter-42 started — npm run dev (pid 1234)"]),
				{ expanded: false, isPartial: false },
				plainTheme,
				{ expanded: false, isError: false },
			)
			.render(160);
		expect(rendered[0]).toContain(icon("process"));
		expect(rendered[0]).toContain("proc-swift-otter-42 started");
		expect(rendered.at(-1)).toBe("- ".repeat(80));
	});

	test("collapsed error shows the error glyph and the message", () => {
		const rendered = tool()
			.renderResult(
				result(false, [], "start requires a command"),
				{ expanded: false, isPartial: false },
				plainTheme,
				{ expanded: false, isError: true },
			)
			.render(80)
			.join("\n");
		expect(rendered).toContain(COLLAPSED_TOOL_GLYPH.error);
		expect(rendered).toContain("start requires a command");
	});

	test("expanded success and error close with status-colored dashes", () => {
		const theme = {
			fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
			bold: (text: string) => text,
		};
		const host = tool();
		const success = host
			.renderResult(result(true, ["started"]), { expanded: true, isPartial: false }, theme, {
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
		expect(success.at(-1)).toBe(`<success>${"- ".repeat(10)}</success>`);
		expect(error.at(-1)).toBe(`<error>${"- ".repeat(10)}</error>`);
	});
});
