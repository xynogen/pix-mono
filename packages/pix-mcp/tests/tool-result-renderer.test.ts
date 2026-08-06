import { describe, expect, it } from "bun:test";
import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import {
	formatMcpDirectToolCallLines,
	formatMcpProxyToolCallLines,
	formatMcpToolResultLines,
	renderMcpToolResult,
} from "../src/tool-result-renderer.ts";

type TestDetails = Record<string, unknown> & { error?: unknown };
type TestResult = AgentToolResult<TestDetails>;

const collapsedOptions: ToolRenderResultOptions = { expanded: false, isPartial: false };
const plainTheme = { fg: (_name: string, text: string) => text };
const boldTheme = { fg: (_name: string, text: string) => text, bold: (t: string) => t };

function result(content: TestResult["content"], details: TestDetails = {}): TestResult {
	return { content, details };
}

describe("MCP tool call renderer", () => {
	it("shows proxy tool calls with parsed JSON arguments", () => {
		const display = formatMcpProxyToolCallLines({
			tool: "cf-portal_list_worker_tail_events",
			server: "cf-portal",
			args: JSON.stringify({ accountId: "abc", scriptName: "worker" }),
		});

		expect(display).toEqual([
			"mcp call cf-portal_list_worker_tail_events @ cf-portal",
			'{\n  "accountId": "abc",\n  "scriptName": "worker"\n}',
		]);
	});

	it("shows proxy discovery operations", () => {
		expect(
			formatMcpProxyToolCallLines({ search: "tail events", server: "cf-portal", regex: true }),
		).toEqual(["mcp search tail events @ cf-portal (regex)"]);
		expect(formatMcpProxyToolCallLines({ connect: "cf-portal" })).toEqual([
			"mcp connect cf-portal",
		]);
		expect(formatMcpProxyToolCallLines({ server: "cf-portal" })).toEqual(["mcp list cf-portal"]);
		expect(formatMcpProxyToolCallLines({})).toEqual(["mcp status"]);
	});

	it("renders ui-messages with execution precedence", () => {
		expect(formatMcpProxyToolCallLines({ action: "ui-messages", server: "cf-portal" })).toEqual([
			"mcp ui-messages",
		]);
	});

	it("shows direct tool calls with JSON arguments", () => {
		const display = formatMcpDirectToolCallLines("cf-portal_list_worker_tail_events", {
			accountId: "abc",
			scriptName: "worker",
		});

		expect(display).toEqual([
			"cf-portal_list_worker_tail_events",
			'{\n  "accountId": "abc",\n  "scriptName": "worker"\n}',
		]);
	});

	it("omits empty direct tool arguments", () => {
		expect(formatMcpDirectToolCallLines("cf-portal_status", {})).toEqual(["cf-portal_status"]);
	});

	it("line-caps a tall pretty-printed args block with a +N note", () => {
		// A wide object pretty-prints to >80 lines; the call row has no expand
		// affordance, so it must collapse like the result view.
		const wide: Record<string, number> = {};
		for (let i = 0; i < 100; i++) wide[`k${i}`] = i;
		const [, json = ""] = formatMcpDirectToolCallLines("big_tool", wide);
		const lines = json.split("\n");
		expect(lines.length).toBe(81); // 80 shown + the note line
		expect(lines.at(-1)).toMatch(/^… \+\d+ more$/);
	});
});

describe("MCP tool result renderer", () => {
	it("caps collapsed text at the preview limit and notes how many lines were hidden", () => {
		// explicit cap keeps the test independent of the MAX_PREVIEW_LINES default
		const display = formatMcpToolResultLines(
			result([{ type: "text", text: "one\ntwo\nthree\nfour\nfive" }]),
			false,
			3,
		);

		expect(display).toEqual({
			lines: ["one", "two", "three", "… +2 more"],
			truncated: true,
		});
	});

	it("does not truncate when collapsed text is within the cap", () => {
		const display = formatMcpToolResultLines(
			result([{ type: "text", text: "one\ntwo\nthree" }]),
			false,
			3,
		);

		expect(display).toEqual({
			lines: ["one", "two", "three"],
			truncated: false,
		});
	});

	it("defaults the collapsed cap to MAX_PREVIEW_LINES (well above a few lines)", () => {
		const display = formatMcpToolResultLines(
			result([{ type: "text", text: "one\ntwo\nthree\nfour" }]),
			false,
		);

		// 4 lines is under the 80-line default, so nothing is hidden.
		expect(display.truncated).toBe(false);
		expect(display.lines).toEqual(["one", "two", "three", "four"]);
	});

	it("shows full text when expanded", () => {
		const display = formatMcpToolResultLines(
			result([{ type: "text", text: "one\ntwo\nthree\nfour" }]),
			true,
		);

		expect(display).toEqual({
			lines: ["one", "two", "three", "four"],
			truncated: false,
		});
	});

	it("uses placeholders for images", () => {
		const display = formatMcpToolResultLines(
			result([
				{ type: "text", text: "before" },
				{ type: "image", mimeType: "image/png", data: "abc" },
			]),
			true,
		);

		expect(display.lines).toEqual(["before", "[image: image/png]"]);
	});

	it("uses an empty-result placeholder when content is empty", () => {
		const display = formatMcpToolResultLines(result([]), false);

		expect(display).toEqual({ lines: ["(empty result)"], truncated: false });
	});

	it("keeps error text visible", () => {
		const display = formatMcpToolResultLines(
			result([{ type: "text", text: "Error: upstream failed\nExpected parameters:\n{}" }]),
			false,
		);

		expect(display.lines).toEqual(["Error: upstream failed", "Expected parameters:", "{}"]);
		expect(display.truncated).toBe(false);
	});

	it("renders long error results expanded even when the row is collapsed", () => {
		const output = renderMcpToolResult(
			result([{ type: "text", text: "Error: failed\nline 2\nline 3\nline 4" }]),
			collapsedOptions,
			plainTheme,
			{ isError: true },
		)
			.render(80)
			.join("\n");

		expect(output).toContain("line 4");
		expect(output).not.toContain("Ctrl+O to expand");
		expect(output).not.toContain("…");
	});

	it("renders adapter error details expanded even when Pi context is not marked as an error", () => {
		const output = renderMcpToolResult(
			result([{ type: "text", text: "Error: failed\nline 2\nline 3\nline 4" }], {
				error: "tool_error",
			}),
			collapsedOptions,
			plainTheme,
			{ isError: false },
		)
			.render(80)
			.join("\n");

		expect(output).toContain("line 4");
		expect(output).not.toContain("Ctrl+O to expand");
		expect(output).not.toContain("…");
	});

	it("collapses a successful result to a one-row summary once the timer fires", () => {
		// A pre-collapsed state bag simulates the post-delay render, like bash/read.
		const output = renderMcpToolResult(
			result([{ type: "text", text: "one\ntwo\nthree" }], { tool: "list_events", server: "cf" }),
			collapsedOptions,
			boldTheme,
			{ isError: false, state: { collapsed: true }, invalidate: () => {} },
		)
			.render(80)
			.join("\n");

		expect(output).toContain("mcp");
		expect(output).toContain("list_events @ cf");
		expect(output).toContain("3 lines");
		expect(output).not.toContain("one"); // body is hidden when collapsed
	});

	it("never collapses an error result even with a collapsed state", () => {
		const output = renderMcpToolResult(
			result([{ type: "text", text: "Error: boom\nline 2" }], { error: "tool_error" }),
			collapsedOptions,
			boldTheme,
			{ isError: false, state: { collapsed: true }, invalidate: () => {} },
		)
			.render(80)
			.join("\n");

		expect(output).toContain("line 2"); // full error stays visible
	});
});
