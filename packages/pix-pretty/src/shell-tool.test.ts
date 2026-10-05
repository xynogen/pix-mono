import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { icon } from "./icon-catalog.ts";
import { collapseProgressFrames, registerShellTool, type ShellToolOptions } from "./shell-tool.ts";
import { capturePi, makeRenderCtx, makeTheme, makeToolContext } from "./test-utils.ts";
import type { ThemeLike, ToolResultLike } from "./types.ts";
import { renderCollapsedToolRow } from "./utils.ts";

const okFactory = () => ({
	execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: undefined }),
});
const emptyFactory = () => ({ execute: async () => ({ content: [], details: undefined }) });
// Tag each fg() call so the rule's status color / hierarchy role is observable.
const keyedTheme: ThemeLike = {
	fg: (key: string, value: string) => `[${key}]${value}[/]`,
	bold: (value: string) => value,
};
// Deterministic summarizer: first line of the command.
const bashOpts: ShellToolOptions = {
	name: "bash",
	summarize: (command) => command.split(" && ")[0] ?? command,
	failurePattern: /command not found/,
};

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

describe("registerShellTool", () => {
	it.each([
		"bash",
		"powershell",
	])("updates %s status before collapse and keeps it when expanded", (name) => {
		const { pi, tool } = capturePi();
		registerShellTool(pi, okFactory, makeToolContext(), { ...bashOpts, name });
		const render = (isPartial: boolean, isError: boolean, expanded = false) =>
			tool
				.renderCall?.({ command: "echo ok" }, keyedTheme, {
					...makeRenderCtx({ isError, expanded, state: { collapsed: false } }),
					isPartial,
				})
				?.render(120)
				.join("\n") ?? "";
		for (const expanded of [false, true]) {
			for (const [isPartial, isError, role, key] of [
				[true, false, "warning", "status.running"],
				[true, true, "warning", "status.running"],
				[false, false, "success", "status.ok"],
				[false, true, "error", "status.error"],
			] as const) {
				const text = render(isPartial, isError, expanded);
				expect(text).toStartWith(`[${role}]${icon(key)}`);
				expect(text).toContain(`[toolTitle]${name}[/]`);
				expect(text).toContain("echo ok");
			}
		}
	});
	it.each(["bash", "powershell"])("aligns %s running and collapsed titles", (name) => {
		const { pi, tool } = capturePi();
		registerShellTool(pi, okFactory, makeToolContext(), { ...bashOpts, name });
		const theme = makeTheme();
		const call = stripVTControlCharacters(
			tool.renderCall?.({ command: "echo ok" }, theme, makeRenderCtx())?.render(120)[0] ?? "",
		);
		const collapsed = stripVTControlCharacters(
			renderCollapsedToolRow(theme, name, "echo ok", "done"),
		);
		expect(call).toStartWith(icon("status.running"));
		expect(visibleWidth(call.slice(0, call.indexOf(name)))).toBe(3);
		expect(visibleWidth(collapsed.slice(0, collapsed.indexOf(name)))).toBe(3);
	});
	it("clamps renderCall to small terminal widths", () => {
		const { pi, tool } = capturePi();
		registerShellTool(pi, okFactory, makeToolContext({ terminalWidth: () => 24 }), bashOpts);

		const text = tool.renderCall?.(
			{
				command: 'printf "very very very long line"\necho second\necho third',
				timeout: 30,
			},
			makeTheme(),
			makeRenderCtx(),
		);

		expect(text).toBeDefined();
		const rendered = text?.render(24).join("\n") ?? "";
		for (const line of rendered.split("\n")) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(24);
		}
	});

	it("combines a collapsed command and result into one compact row", () => {
		const { pi, tool } = capturePi();
		// Pin a wide width so the compact row isn't truncated by another test's termW mutation.
		registerShellTool(pi, okFactory, makeToolContext({ terminalWidth: () => 120 }), bashOpts);
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
		const openCall = tool.renderCall?.({ command: "echo hello" }, theme, makeRenderCtx());
		const hiddenCall = tool.renderCall?.(
			{ command: "echo hello" },
			theme,
			makeRenderCtx({ state: { collapsed: true }, lastComponent: openCall }),
		);
		expect(hiddenCall?.getText()).toBe("");
		expect(hiddenCall?.render(80)).toEqual([]);
		expect(result?.getText()).toContain("bun test && bun run lint && git diff --check");
		expect(result?.getText()).toContain("<muted>2 lines · 2.5s</muted>");
		expect(result?.render(24).join("\n")).toContain("…");
	});

	it("restores full output when an elapsed card is expanded", () => {
		const { pi, tool } = capturePi();
		registerShellTool(pi, okFactory, makeToolContext(), bashOpts);
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
		registerShellTool(pi, emptyFactory, makeToolContext(), bashOpts);
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
		expect(render({ timer: 1 })).toContain("- -");
		expect(render({ collapsed: true })).toContain("✗  bash · exit 1");
		expect(render({ collapsed: true }, true)).toContain(diagnostic);

		const partial =
			tool
				.renderResult?.(result, { isPartial: true }, theme, makeRenderCtx({ isError: true }))
				?.getText() ?? "";
		expect(partial).toContain(diagnostic);
		expect(partial.split("\n")).toHaveLength(1);
	});

	it("frames single-line output like multi-line (no inline row)", () => {
		const { pi, tool } = capturePi();
		registerShellTool(pi, emptyFactory, makeToolContext(), bashOpts);
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
		expect(collapsed).toContain("- -");
		expect(collapsed).toContain("Checked 382 files");
		// Body starts at the title column (2-cell icon + space).
		expect(strip(collapsed)).toMatch(/^\tChecked 382 files/m);
		expect(strip(collapsed)).not.toContain("✓ exit 0");
		const expanded =
			tool
				.renderResult?.(single, { isPartial: false }, theme, makeRenderCtx({ expanded: true }))
				?.getText() ?? "";
		// expanded single-line should still have the dashed close
		expect(expanded).toContain("- -");
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
		expect(multiOut).toContain("- -");
		// Framed view drops the `✓ exit 0` header — the collapsed row already carries it.
		expect(multiOut).not.toContain("✓ exit 0");
	});

	it("frames completed generic results but leaves partial results open", () => {
		const { pi, tool } = capturePi();
		registerShellTool(pi, emptyFactory, makeToolContext(), bashOpts);
		if (!tool.renderResult) throw new Error("renderResult not registered");
		const renderResult = tool.renderResult;
		const render = (isError: boolean, isPartial: boolean) =>
			renderResult(
				{ content: [{ type: "text", text: isError ? "failed" : "done" }], details: undefined },
				{ isPartial },
				keyedTheme,
				makeRenderCtx({ isError }),
			)
				.render(20)
				.join("\n");

		expect(render(false, false)).toContain("[success]- -");
		expect(render(false, false)).not.toContain("└─");
		expect(render(true, false)).toContain("[error]- -");
		expect(render(true, false)).not.toContain("└─");
		expect(render(false, true)).not.toContain("[success]- -");
	});

	it("shows the latest five lines while a command runs", () => {
		const { pi, tool } = capturePi();
		registerShellTool(pi, emptyFactory, makeToolContext(), bashOpts);
		const rendered = tool
			.renderResult?.(
				{
					content: [{ type: "text", text: "one\ntwo\nthree\nfour\nfive\nsix" }],
					details: undefined,
				},
				{ isPartial: true },
				makeTheme(),
				makeRenderCtx(),
			)
			?.getText();

		expect(
			rendered
				?.replace(/\u001b\[[0-9;]*m/g, "")
				.split("\n")
				.map((line) => line.trim()),
		).toEqual(["two", "three", "four", "five", "six"]);
	});

	it("tints the frame rules green on success and red on failure", () => {
		const { pi, tool } = capturePi();
		registerShellTool(pi, emptyFactory, makeToolContext(), bashOpts);
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
		expect(render(0)).toContain("[success]- -"); // close painted success
		expect(render(0)).not.toContain("└─");
		expect(render(1)).toContain("[error]- -"); // non-zero exit → red close
		expect(render(1)).not.toContain("└─");
		expect(render(null)).toContain("[success]- -"); // completed return without a failure is success
	});

	it("collapses a non-zero exit thrown by Pi's built-in bash tool", async () => {
		const { pi, tool } = capturePi();
		registerShellTool(
			pi,
			() => ({
				execute: async () => {
					throw new Error("test failed\n\nCommand exited with code 1");
				},
			}),
			makeToolContext(),
			bashOpts,
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

	it("registers, labels, and collapses under the configured tool name", () => {
		const { pi, tool, names } = capturePi();
		registerShellTool(pi, okFactory, makeToolContext({ terminalWidth: () => 120 }), {
			name: "powershell",
			summarize: () => "Get-ChildItem",
		});
		const theme = makeTheme({ tag: true });
		const call = tool.renderCall?.({ command: "Get-ChildItem -Force" }, theme, makeRenderCtx());
		const collapsed = tool.renderResult?.(
			{
				content: [{ type: "text", text: "a" }],
				details: { _type: "bashResult", text: "a", exitCode: 0, command: "x", durationMs: 0 },
			},
			undefined,
			theme,
			makeRenderCtx({ state: { collapsed: true } }),
		);

		expect(names).toEqual(["powershell"]);
		expect(call?.getText()).toMatch(/powershell.*<dim>Get-ChildItem -Force/);
		expect(collapsed?.getText()).toContain("<dim>x</dim>");
	});

	it("marks output matching failurePattern as exit 1 when no code is reported", async () => {
		const { pi, tool } = capturePi();
		registerShellTool(
			pi,
			() => ({
				execute: async () => ({
					content: [{ type: "text" as const, text: "foo: command not found" }],
					details: undefined,
				}),
			}),
			makeToolContext(),
			bashOpts,
		);
		const execute = tool.execute as (...args: unknown[]) => Promise<ToolResultLike>;
		const result = await execute("call-1", { command: "foo" }, undefined, undefined, {});
		expect(result.details).toMatchObject({ _type: "bashResult", exitCode: 1, command: "foo" });
	});
});
