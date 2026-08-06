import { describe, expect, it } from "bun:test";
import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import {
	formatMcpDirectToolCallLines,
	formatMcpProxyToolCallLines,
	formatMcpToolResultLines,
	renderMcpProxyToolCall,
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

	it("blanks the call row once collapsed so only the result summary shows", () => {
		const args = { tool: "q", server: "s", args: JSON.stringify({ use_case: "fibery" }) };
		// Expanded (or pre-collapse) still shows the full call + JSON args.
		const full = renderMcpProxyToolCall(args, boldTheme, {
			state: { collapsed: false } as never,
			invalidate: () => {},
		})
			.render(80)
			.join("\n");
		expect(full).toContain("mcp call q @ s");
		expect(full).toContain("use_case");

		// Collapsed: call row is blank (the result renderer owns the one-line summary).
		const collapsed = renderMcpProxyToolCall(args, boldTheme, {
			state: { collapsed: true } as never,
			expanded: false,
			invalidate: () => {},
		})
			.render(80)
			.join("\n");
		expect(collapsed.trim()).toBe("");

		// Re-expanding a collapsed row restores the full call.
		const reExpanded = renderMcpProxyToolCall(args, boldTheme, {
			state: { collapsed: true } as never,
			expanded: true,
			invalidate: () => {},
		})
			.render(80)
			.join("\n");
		expect(reExpanded).toContain("mcp call q @ s");
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
	it("starts output with a separator line", () => {
		const lines = renderMcpToolResult(
			result([{ type: "text", text: JSON.stringify({ ok: true }) }]),
			{ expanded: true, isPartial: false },
			plainTheme,
		)
			.render(12)
			.map((l: string) => l.replace(/\x1b\[[0-9;]*m/g, ""));

		expect(lines[0]).toBe("─".repeat(12));
		expect(lines.slice(1).join("\n")).toContain('"ok"');
	});

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

	it("highlights the preview — body is pre-shaped so highlighting is cheap", () => {
		// blockToLines pretty-formats + wraps the body into a small, short-lined set
		// (no mega-line), so cli-highlighting the preview is affordable. The preview
		// gets highlighted, keyed distinctly from the expanded view.
		const json = '{\n  "ok": true,\n  "n": 3\n}';
		const state: Record<string, unknown> = {};
		const notExpanded: ToolRenderResultOptions = { expanded: false, isPartial: false };
		renderMcpToolResult(
			result([{ type: "text", text: json }], { tool: "q", server: "s" }),
			notExpanded,
			boldTheme,
			{ isError: false, state: state as never, invalidate: () => {} },
		);
		// Highlight IS scheduled in the preview's independent cache slot.
		const highlights = state._highlights as Record<string, { key: string }>;
		expect(highlights["mcp:preview"]?.key).toBeDefined();
	});

	it("highlights a TRUNCATED preview body while keeping the `+N more` footer off the highlight", async () => {
		// Regression: a large result truncates to 80 lines + a footer, which never
		// fully parses as JSON. Highlighting must still fire on the body (cli-
		// highlight handles partial JSON) and the footer must be excluded from it.
		const big = JSON.stringify({
			results: Array.from({ length: 300 }, (_, i) => ({ i, name: `item-${i}` })),
		});
		const state: Record<string, unknown> = {};
		const notExpanded: ToolRenderResultOptions = { expanded: false, isPartial: false };
		const render = () =>
			renderMcpToolResult(
				result([{ type: "text", text: big }], { tool: "q", server: "s" }),
				notExpanded,
				boldTheme,
				{ isError: false, state: state as never, invalidate: () => {} },
			);
		render();
		// Highlight scheduled on the truncated preview body.
		const highlights = state._highlights as Record<string, { key: string }>;
		expect(highlights["mcp:preview"]?.key).toBeDefined();
		// The highlighted body must NOT include the footer line.
		expect(highlights["mcp:preview"]?.key).not.toContain("more");
		await new Promise((r) => setTimeout(r, 30));
		// The rendered output still carries the muted footer.
		const out = render().render(80).join("\n");
		expect(out).toContain("more");
	});

	it("clips a long JSON string value to one row in preview but wraps it when expanded", () => {
		// A single long string value stays on one logical line (wrapping mid-token
		// would break highlighting). Preview must clip it to one screen row — like
		// pix-read — so a fat value never balloons into a tall blob. Expanded wraps.
		const longVal = "x".repeat(600);
		const json = JSON.stringify({ blurb: longVal });
		const state: Record<string, unknown> = {};
		const preview = renderMcpToolResult(
			result([{ type: "text", text: json }], { tool: "q", server: "s" }),
			{ expanded: false, isPartial: false },
			boldTheme,
			{ isError: false, state: state as never, invalidate: () => {} },
		)
			.render(80)
			.map((l: string) => l.replace(/\x1b\[[0-9;]*m/g, ""));
		// Every row fits the width and the long value is clipped, not wrapped.
		expect(Math.max(...preview.map((l: string) => l.length))).toBeLessThanOrEqual(80);
		expect(preview.some((l: string) => l.includes("›"))).toBe(true);

		const expandedState: Record<string, unknown> = {};
		const expanded = renderMcpToolResult(
			result([{ type: "text", text: json }], { tool: "q", server: "s" }),
			{ expanded: true, isPartial: false },
			boldTheme,
			{ isError: false, state: expandedState as never, invalidate: () => {} },
		)
			.render(80)
			.map((l: string) => l.replace(/\x1b\[[0-9;]*m/g, ""));
		// Expanded wraps the value across rows (no clip marker) — nothing hidden.
		expect(expanded.some((l: string) => l.includes("›"))).toBe(false);
		expect(expanded.length).toBeGreaterThan(preview.length);
	});

	it("keeps call and result highlight caches separate", async () => {
		const state: Record<string, unknown> = {};
		let invalidations = 0;
		const context = {
			isError: false,
			expanded: true,
			state: state as never,
			invalidate: () => {
				invalidations++;
			},
		};
		const renderBoth = () => {
			renderMcpProxyToolCall(
				{ tool: "q", server: "s", args: JSON.stringify({ query: "fibery" }) },
				boldTheme,
				context,
			);
			renderMcpToolResult(
				result([{ type: "text", text: JSON.stringify({ data: { ok: true } }) }]),
				{ expanded: true, isPartial: false },
				boldTheme,
				context,
			);
		};

		renderBoth();
		await new Promise((resolve) => setTimeout(resolve, 20));
		const settledInvalidations = invalidations;
		renderBoth();
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(settledInvalidations).toBe(2);
		expect(invalidations).toBe(settledInvalidations);
	});

	it("schedules JSON highlighting and repaints via invalidate", async () => {
		const json = '{\n  "ok": true,\n  "n": 3\n}';
		const state: Record<string, unknown> = {};
		let invalidated = false;
		// expanded: true skips the collapse timer so the highlight path runs.
		const expandedOptions: ToolRenderResultOptions = { expanded: true, isPartial: false };
		const render = () =>
			renderMcpToolResult(
				result([{ type: "text", text: json }], { tool: "q", server: "s" }),
				expandedOptions,
				boldTheme,
				{
					isError: false,
					state: state as never,
					invalidate: () => {
						invalidated = true;
					},
				},
			);
		// First render: highlight not ready — kicks off async hlBlock, returns plain.
		render();
		const highlights = state._highlights as Record<string, { key: string; text?: string }>;
		expect(highlights["mcp:full"]?.key).toBeDefined();
		await new Promise((r) => setTimeout(r, 20));
		expect(invalidated).toBe(true);
		expect(highlights["mcp:full"]?.text).toBeDefined();
		// Second render uses the cached highlighted text (still contains the keys).
		const out = render().render(80).join("\n");
		expect(out).toContain("ok");
		expect(out).toContain("3");
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
