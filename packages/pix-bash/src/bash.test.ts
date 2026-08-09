import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { CursorStore, FffState } from "@xynogen/pix-pretty/fff";
import type {
	PiPrettyApi,
	RenderContextLike,
	TextComponentCtor,
	ThemeLike,
	ToolResultLike,
} from "@xynogen/pix-pretty/types";
import { formatBashDuration, registerBashTool, summarizeBashCommand } from "./bash";

class MockTextComponent {
	private text: string;

	constructor(text = "") {
		this.text = text;
	}

	setText(value: string): void {
		this.text = value;
	}

	getText(): string {
		return this.text;
	}
}

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
		const registered: {
			renderCall?: (...args: unknown[]) => MockTextComponent;
		} = {};
		const mockPi: PiPrettyApi = {
			registerTool(tool: unknown) {
				Object.assign(registered, tool);
			},
			registerCommand() {},
			on() {},
		};

		registerBashTool(
			mockPi,
			() => ({
				execute: async () => ({
					content: [{ type: "text", text: "ok" }],
					details: undefined,
				}),
			}),
			{
				cwd: process.cwd(),
				sp: (p: string) => p,
				TextComponent: MockTextComponent as unknown as TextComponentCtor,
				fffState: {
					module: null,
					finder: null,
					partialIndex: false,
					dbDir: null,
				} satisfies FffState,
				cursorStore: {
					store: () => "",
					get: () => undefined,
				} as unknown as CursorStore,
				terminalWidth: () => 24,
			},
		);

		const theme: ThemeLike = {
			fg: (_key: string, value: string) => value,
			bold: (value: string) => value,
		};
		const ctx: RenderContextLike = {
			expanded: false,
			isError: false,
			invalidate: () => {},
			state: {},
		};

		const text = registered.renderCall?.(
			{
				command: 'printf "very very very long line"\necho second\necho third',
				timeout: 30,
			},
			theme,
			ctx,
		);

		expect(text).toBeDefined();
		const rendered = text?.getText() ?? "";
		for (const line of rendered.split("\n")) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(24);
		}
	});

	it("combines a collapsed command and result into one compact row", () => {
		const registered: {
			renderCall?: (...args: unknown[]) => MockTextComponent;
			renderResult?: (...args: unknown[]) => MockTextComponent;
		} = {};
		const mockPi: PiPrettyApi = {
			registerTool(tool: unknown) {
				Object.assign(registered, tool);
			},
			registerCommand() {},
			on() {},
		};

		registerBashTool(
			mockPi,
			() => ({
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
			}),
			{
				cwd: process.cwd(),
				sp: (p: string) => p,
				TextComponent: MockTextComponent as unknown as TextComponentCtor,
				fffState: { module: null, finder: null, partialIndex: false, dbDir: null },
				cursorStore: { store: () => "", get: () => undefined } as unknown as CursorStore,
			},
		);

		const theme: ThemeLike = {
			fg: (key: string, value: string) => (key === "muted" ? `<muted>${value}</muted>` : value),
			bold: (value: string) => value,
		};
		const collapsedCtx = {
			expanded: false,
			isError: false,
			invalidate: () => {},
			state: { collapsed: true },
		} as unknown as RenderContextLike;
		const call = registered.renderCall?.(
			{ command: "bun test && bun run lint && git diff --check", timeout: 30 },
			theme,
			collapsedCtx,
		);
		const result = registered.renderResult?.(
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
		expect(result?.getText()).toContain("✓  bash <muted>bun test · +2 steps</muted>");
		expect(result?.getText()).toContain("2 lines · 2.5s");
		expect(result?.getText()).not.toContain("git diff --check");
	});

	it("restores full output when an elapsed card is expanded", () => {
		const registered: { renderResult?: (...args: unknown[]) => MockTextComponent } = {};
		const mockPi: PiPrettyApi = {
			registerTool(tool: unknown) {
				Object.assign(registered, tool);
			},
			registerCommand() {},
			on() {},
		};
		registerBashTool(
			mockPi,
			() => ({
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
			}),
			{
				cwd: process.cwd(),
				sp: (p: string) => p,
				TextComponent: MockTextComponent as unknown as TextComponentCtor,
				fffState: { module: null, finder: null, partialIndex: false, dbDir: null },
				cursorStore: { store: () => "", get: () => undefined } as unknown as CursorStore,
			},
		);
		const theme: ThemeLike = {
			fg: (_key: string, value: string) => value,
			bold: (value: string) => value,
		};
		const result = registered.renderResult?.(
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
			theme,
			{
				expanded: true,
				isError: false,
				invalidate: () => {},
				state: { collapsed: true },
			} as unknown as RenderContextLike,
		);

		expect(result?.getText()).toContain("one");
		expect(result?.getText()).toContain("two");
		expect(result?.getText()).not.toContain("✓ bash");
	});

	it("collapses structured errors and restores the exact diagnostic on expansion", () => {
		const registered: { renderResult?: (...args: unknown[]) => MockTextComponent } = {};
		const mockPi: PiPrettyApi = {
			registerTool(tool: unknown) {
				Object.assign(registered, tool);
			},
			registerCommand() {},
			on() {},
		};
		registerBashTool(
			mockPi,
			() => ({ execute: async () => ({ content: [], details: undefined }) }),
			{
				cwd: process.cwd(),
				sp: (p: string) => p,
				TextComponent: MockTextComponent as unknown as TextComponentCtor,
				fffState: { module: null, finder: null, partialIndex: false, dbDir: null },
				cursorStore: { store: () => "", get: () => undefined } as unknown as CursorStore,
			},
		);
		const theme: ThemeLike = {
			fg: (_key: string, value: string) => value,
			bold: (value: string) => value,
		};
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
		const render = (state: Record<string, unknown>, expanded = false) =>
			registered
				.renderResult?.(result, { isPartial: false }, theme, {
					expanded,
					isError: true,
					invalidate: () => {},
					state,
				} as unknown as RenderContextLike)
				?.getText() ?? "";

		expect(render({ timer: 1 })).toContain(diagnostic);
		expect(render({ collapsed: true })).toContain("✗  bash bun test · exit 1");
		expect(render({ collapsed: true }, true)).toContain(diagnostic);
	});

	it("frames single-line output like multi-line (no inline row)", () => {
		const registered: { renderResult?: (...args: unknown[]) => MockTextComponent } = {};
		const mockPi: PiPrettyApi = {
			registerTool(tool: unknown) {
				Object.assign(registered, tool);
			},
			registerCommand() {},
			on() {},
		};
		registerBashTool(
			mockPi,
			() => ({ execute: async () => ({ content: [], details: undefined }) }),
			{
				cwd: process.cwd(),
				sp: (p: string) => p,
				TextComponent: MockTextComponent as unknown as TextComponentCtor,
				fffState: { module: null, finder: null, partialIndex: false, dbDir: null },
				cursorStore: { store: () => "", get: () => undefined } as unknown as CursorStore,
			},
		);
		const theme: ThemeLike = { fg: (_k: string, v: string) => v, bold: (v: string) => v };
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
			registered
				.renderResult?.(single, { isPartial: false }, theme, {
					expanded: false,
					isError: false,
					invalidate: () => {},
					state: {},
				} as unknown as RenderContextLike)
				?.getText() ?? "";
		// Single-line output is now framed just like multi-line — no inline row,
		// no "✓ exit 0" header; the rules carry status by color.
		expect(collapsed).toContain("─");
		expect(collapsed).toContain("Checked 382 files");
		expect(strip(collapsed)).not.toContain("✓ exit 0");
		const expanded =
			registered
				.renderResult?.(single, { isPartial: false }, theme, {
					expanded: true,
					isError: false,
					invalidate: () => {},
					state: {},
				} as unknown as RenderContextLike)
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
			registered
				.renderResult?.(multi, { isPartial: false }, theme, {
					expanded: false,
					isError: false,
					invalidate: () => {},
					state: {},
				} as unknown as RenderContextLike)
				?.getText() ?? "";
		expect(multiOut).toContain("─");
		// Framed view drops the `✓ exit 0` header — the collapsed row already carries it.
		expect(multiOut).not.toContain("✓ exit 0");
	});

	it("tints the frame rules green on success and red on failure", () => {
		const registered: { renderResult?: (...args: unknown[]) => MockTextComponent } = {};
		const mockPi: PiPrettyApi = {
			registerTool(tool: unknown) {
				Object.assign(registered, tool);
			},
			registerCommand() {},
			on() {},
		};
		registerBashTool(
			mockPi,
			() => ({ execute: async () => ({ content: [], details: undefined }) }),
			{
				cwd: process.cwd(),
				sp: (p: string) => p,
				TextComponent: MockTextComponent as unknown as TextComponentCtor,
				fffState: { module: null, finder: null, partialIndex: false, dbDir: null },
				cursorStore: { store: () => "", get: () => undefined } as unknown as CursorStore,
			},
		);
		// Tag each fg() call so the rule's status color is observable in the output.
		const theme: ThemeLike = {
			fg: (k: string, v: string) => `[${k}]${v}[/]`,
			bold: (v: string) => v,
		};
		// exitCode drives the rule tint; isError:false keeps the framed (non-error) branch
		// so a non-zero exit still renders framed output with red rules.
		const render = (exitCode: number | null) =>
			registered
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
					theme,
					{
						expanded: false,
						isError: false,
						invalidate: () => {},
						state: {},
					} as unknown as RenderContextLike,
				)
				?.getText() ?? "";
		expect(render(0)).toContain("[success]─"); // top+bottom rules painted success
		expect(render(1)).toContain("[error]─"); // non-zero exit → red rules
		expect(render(null)).toContain("[dim]─"); // unknown exit → neutral dim rules
	});

	it("collapses a non-zero exit thrown by Pi's built-in bash tool", async () => {
		const registered: {
			execute?: (...args: unknown[]) => Promise<ToolResultLike & { isError?: boolean }>;
			renderResult?: (...args: unknown[]) => MockTextComponent;
		} = {};
		const mockPi: PiPrettyApi = {
			registerTool(tool: unknown) {
				Object.assign(registered, tool);
			},
			registerCommand() {},
			on() {},
		};
		registerBashTool(
			mockPi,
			() => ({
				execute: async () => {
					throw new Error("test failed\n\nCommand exited with code 1");
				},
			}),
			{
				cwd: process.cwd(),
				sp: (p: string) => p,
				TextComponent: MockTextComponent as unknown as TextComponentCtor,
				fffState: { module: null, finder: null, partialIndex: false, dbDir: null },
				cursorStore: { store: () => "", get: () => undefined } as unknown as CursorStore,
			},
		);

		const result = await registered.execute!(
			"call-1",
			{ command: "bun test" },
			undefined,
			undefined,
			{},
		);
		expect(result.isError).toBe(true);
		expect(result.details).toMatchObject({ _type: "bashResult", exitCode: 1 });

		const theme: ThemeLike = {
			fg: (_key: string, value: string) => value,
			bold: (value: string) => value,
		};
		const rendered = registered.renderResult?.(result, { isPartial: false }, theme, {
			expanded: false,
			isError: true,
			invalidate: () => {},
			state: { collapsed: true },
		} as unknown as RenderContextLike);
		expect(rendered?.getText()).toContain("✗  bash bun test · exit 1");
	});
});
