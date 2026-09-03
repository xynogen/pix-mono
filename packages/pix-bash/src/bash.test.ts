import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	capturePi,
	makeRenderCtx,
	makeTheme,
	makeToolContext,
} from "@xynogen/pix-pretty/test-utils";
import type { ThemeLike, ToolResultLike } from "@xynogen/pix-pretty/types";
import { formatBashDuration, registerBashTool, summarizeBashCommand } from "./bash";

const okFactory = () => ({
	execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: undefined }),
});
const emptyFactory = () => ({ execute: async () => ({ content: [], details: undefined }) });
// Tag each fg() call so the rule's status color / hierarchy role is observable.
const keyedTheme: ThemeLike = {
	fg: (key: string, value: string) => `[${key}]${value}[/]`,
	bold: (value: string) => value,
};

describe("bash summaries", () => {
	it("summarizes command chains instead of repeating the full command", () => {
		expect(summarizeBashCommand("bun test && bun run lint && git diff --check")).toBe(
			"bun test · +2 steps",
		);
		expect(summarizeBashCommand("set -e\nTAG=release-1\ngit tag $TAG\ngit push origin $TAG")).toBe(
			"shell script · 3 lines",
		);
	});

	it("formats short durations compactly", () => {
		expect(formatBashDuration(420)).toBe("420ms");
		expect(formatBashDuration(2_450)).toBe("2.5s");
		expect(formatBashDuration(12_400)).toBe("12s");
	});
});

describe("registerBashTool", () => {
	it("clamps renderCall to small terminal widths", () => {
		const { pi, tool } = capturePi();
		registerBashTool(pi, okFactory, makeToolContext({ terminalWidth: () => 24 }));

		const text = tool.renderCall?.(
			{
				command: 'printf "very very very long line"\necho second\necho third',
				timeout: 30,
			},
			makeTheme(),
			makeRenderCtx(),
		);

		expect(text).toBeDefined();
		const rendered = text?.getText() ?? "";
		for (const line of rendered.split("\n")) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(24);
		}
	});

	it("combines a collapsed command and result into one compact row", () => {
		const { pi, tool } = capturePi();
		// Pin a wide width so the compact row isn't truncated by another test's termW mutation.
		registerBashTool(pi, okFactory, makeToolContext({ terminalWidth: () => 120 }));
		const theme = makeTheme({ tag: true });
		const collapsedCtx = makeRenderCtx({ state: { collapsed: true } });
		const call = tool.renderCall?.(
			{ command: "bun test && bun run lint && git diff --check", timeout: 30 },
			theme,
			collapsedCtx,
		);
		const result = tool.renderResult?.(
			{
				content: [{ type: "text", text: "one\ntwo" }],
				details: {
					_type: "bashResult",
					text: "one\ntwo",
					exitCode: 0,
					command: "bun test && bun run lint && git diff --check",
					durationMs: 2_450,
				},
			},
			undefined,
			theme,
			collapsedCtx,
		);

		expect(call?.getText()).toBe("");
		expect(result?.getText()).toContain("✓  bash <dim>bun test · +2 steps</dim>");
		expect(result?.getText()).toContain("<muted>2 lines · 2.5s</muted>");
		expect(result?.getText()).not.toContain("git diff --check");
	});

	it("restores full output when an elapsed card is expanded", () => {
		const { pi, tool } = capturePi();
		registerBashTool(pi, okFactory, makeToolContext());
		const result = tool.renderResult?.(
			{
				content: [{ type: "text", text: "one\ntwo" }],
				details: {
					_type: "bashResult",
					text: "one\ntwo",
					exitCode: 0,
					command: "printf one",
					durationMs: 100,
				},
			},
			undefined,
			makeTheme(),
			makeRenderCtx({ expanded: true, state: { collapsed: true } }),
		);

		expect(result?.getText()).toContain("one");
		expect(result?.getText()).toContain("two");
		expect(result?.getText()).not.toContain("✓ bash");
	});

	it("collapses structured errors and restores the exact diagnostic on expansion", () => {
		const { pi, tool } = capturePi();
		registerBashTool(pi, emptyFactory, makeToolContext());
		const theme = makeTheme();
		const diagnostic = "AssertionError: expected 1 to equal 2";
		const result = {
			content: [{ type: "text", text: diagnostic }],
			details: {
				_type: "bashResult",
				text: diagnostic,
				exitCode: 1,
				command: "bun test",
				durationMs: 100,
			},
		};
		const render = (state: Record<string, unknown>, expanded = false) => {
			const component = tool.renderResult?.(
				result,
				{ isPartial: false },
				theme,
				makeRenderCtx({ isError: true, expanded, state }),
			);
			return component?.render(120).join("\n") ?? "";
		};

		expect(render({ timer: 1 })).toContain(diagnostic);
		expect(render({ timer: 1 })).toContain("─");
		expect(render({ collapsed: true })).toContain("✗  bash bun test · exit 1");
		expect(render({ collapsed: true }, true)).toContain(diagnostic);

		const partial =
			tool
				.renderResult?.(result, { isPartial: true }, theme, makeRenderCtx({ isError: true }))
				?.getText() ?? "";
		expect(partial).not.toContain("─");
	});

	it("frames single-line output like multi-line (no inline row)", () => {
		const { pi, tool } = capturePi();
		registerBashTool(pi, emptyFactory, makeToolContext());
		const theme = makeTheme();
		const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
		const single = {
			content: [{ type: "text", text: "Checked 382 files" }],
			details: {
				_type: "bashResult",
				text: "Checked 382 files",
				exitCode: 0,
				command: "bun run check",
				durationMs: 0,
			},
		};
		const collapsed =
			tool.renderResult?.(single, { isPartial: false }, theme, makeRenderCtx())?.getText() ?? "";
		// Single-line output is now framed just like multi-line — no inline row,
		// no "✓ exit 0" header; the rules carry status by color.
		expect(collapsed).toContain("─");
		expect(collapsed).toContain("Checked 382 files");
		expect(strip(collapsed)).not.toContain("✓ exit 0");
		const expanded =
			tool
				.renderResult?.(single, { isPartial: false }, theme, makeRenderCtx({ expanded: true }))
				?.getText() ?? "";
		// expanded single-line should still be framed
		expect(expanded).toContain("─");
		const multi = {
			content: [{ type: "text", text: "a\nb\nc" }],
			details: {
				_type: "bashResult",
				text: "a\nb\nc",
				exitCode: 0,
				command: "echo",
				durationMs: 0,
			},
		};
		const multiOut =
			tool.renderResult?.(multi, { isPartial: false }, theme, makeRenderCtx())?.getText() ?? "";
		expect(multiOut).toContain("─");
		// Framed view drops the `✓ exit 0` header — the collapsed row already carries it.
		expect(multiOut).not.toContain("✓ exit 0");
	});

	it("frames completed generic results but leaves partial results open", () => {
		const { pi, tool } = capturePi();
		registerBashTool(pi, emptyFactory, makeToolContext());
		if (!tool.renderResult) throw new Error("renderResult not registered");
		const renderResult = tool.renderResult;
		const render = (isError: boolean, isPartial: boolean) =>
			renderResult(
				{ content: [{ type: "text", text: isError ? "failed" : "done" }], details: undefined },
				{ isPartial },
				keyedTheme,
				makeRenderCtx({ expanded: true, isError }),
			)
				.render(20)
				.join("\n");

		expect(render(false, false)).toContain("[success]─");
		expect(render(true, false)).toContain("[error]─");
		expect(render(false, true)).not.toContain("[success]─");
	});

	it("tints the frame rules green on success and red on failure", () => {
		const { pi, tool } = capturePi();
		registerBashTool(pi, emptyFactory, makeToolContext());
		// exitCode drives the rule tint; isError:false keeps the framed (non-error) branch
		// so a non-zero exit still renders framed output with red rules.
		const render = (exitCode: number | null) =>
			tool
				.renderResult?.(
					{
						content: [{ type: "text", text: "a\nb\nc" }],
						details: {
							_type: "bashResult",
							text: "a\nb\nc",
							exitCode,
							command: "x",
							durationMs: 0,
						},
					},
					{ isPartial: false },
					keyedTheme,
					makeRenderCtx(),
				)
				?.getText() ?? "";
		expect(render(0)).toContain("[success]─"); // top+bottom rules painted success
		expect(render(1)).toContain("[error]─"); // non-zero exit → red rules
		expect(render(null)).toContain("[success]─"); // completed return without a failure is success
	});

	it("collapses a non-zero exit thrown by Pi's built-in bash tool", async () => {
		const { pi, tool } = capturePi();
		registerBashTool(
			pi,
			() => ({
				execute: async () => {
					throw new Error("test failed\n\nCommand exited with code 1");
				},
			}),
			makeToolContext(),
		);

		const execute = tool.execute as (
			...args: unknown[]
		) => Promise<ToolResultLike & { isError?: boolean }>;
		const result = await execute("call-1", { command: "bun test" }, undefined, undefined, {});
		expect(result.isError).toBe(true);
		expect(result.details).toMatchObject({ _type: "bashResult", exitCode: 1 });

		const rendered = tool.renderResult?.(
			result,
			{ isPartial: false },
			makeTheme(),
			makeRenderCtx({ isError: true, state: { collapsed: true } }),
		);
		expect(rendered?.getText()).toContain("✗  bash bun test · exit 1");
	});
});
