import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	capturePi,
	makeRenderCtx,
	makeTheme,
	makeToolContext,
} from "@xynogen/pix-pretty/test-utils";
import type { ToolResultLike } from "@xynogen/pix-pretty/types";
import {
	collapseProgressFrames,
	formatBashDuration,
	registerBashTool,
	summarizeBashCommand,
} from "./bash";

const okFactory = () => ({
	execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: undefined }),
});

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

describe("collapseProgressFrames", () => {
	it("keeps only the final frame of a CR-overwritten progress line", () => {
		expect(collapseProgressFrames("Progress: 10%\rProgress: 50%\rProgress: 100%")).toBe(
			"Progress: 100%",
		);
	});

	it("treats CRLF as a real newline, CR alone as overwrite", () => {
		expect(collapseProgressFrames("line one\r\nold\rnew")).toBe("line one\nnew");
	});

	it("strips cursor/erase control codes but keeps SGR color", () => {
		expect(collapseProgressFrames("\x1b[2K\x1b[31mred\x1b[0m")).toBe("\x1b[31mred\x1b[0m");
	});

	it("leaves plain multi-line output untouched", () => {
		expect(collapseProgressFrames("a\nb\nc")).toBe("a\nb\nc");
	});
});

describe("registerBashTool", () => {
	it("clamps renderCall to small terminal widths", async () => {
		const { pi, tool } = capturePi();
		registerBashTool(pi, okFactory, makeToolContext({ terminalWidth: () => 24 }));
		// ponytail: shared shell captures own layout. Keep the package self-shell wiring here.
		expect(tool.renderShell).toBe("self");

		let invalidated!: () => void;
		const ready = new Promise<void>((resolve) => {
			invalidated = resolve;
		});
		const callCtx = makeRenderCtx({ invalidate: invalidated });
		const text = tool.renderCall?.(
			{
				command: 'printf "very very very long line"\necho second\necho third',
				timeout: 30,
			},
			makeTheme(),
			callCtx,
		);

		await ready;
		expect(callCtx.state.commandPreview).toMatchObject({ language: "bash" });
		expect(text).toBeDefined();
		const rendered = text?.render(24).join("\n") ?? "";
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
		expect(result?.getText()).toContain("bun test && bun run lint && git diff --check");
		expect(result?.getText()).toContain("<muted>2 lines · 2.5s</muted>");
		expect(result?.render(24).join("\n")).toContain("…");
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
		expect(rendered?.getText()).toContain("✗  bash · exit 1");
	});
});
