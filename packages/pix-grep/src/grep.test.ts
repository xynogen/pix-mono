import { describe, expect, it } from "bun:test";
import type { CursorStore, FffState } from "@xynogen/pix-pretty/fff";
import type {
	PiPrettyApi,
	RenderContextLike,
	TextComponentCtor,
	ThemeLike,
} from "@xynogen/pix-pretty/types";
import { applyGrepDefaults, DEFAULT_GREP_LIMIT, grepHighlight, registerGrepTool } from "./grep";

class MockTextComponent {
	private text = "";
	setText(v: string) {
		this.text = v;
	}
	getText() {
		return this.text;
	}
	render(_width?: number) {
		return this.text.split("\n");
	}
	invalidate() {}
}

describe("applyGrepDefaults", () => {
	it("applies a conservative default without overriding an explicit limit", () => {
		expect(applyGrepDefaults({ pattern: "TODO" })).toEqual({
			pattern: "TODO",
			limit: DEFAULT_GREP_LIMIT,
		});
		expect(applyGrepDefaults({ pattern: "TODO", limit: 5 })).toEqual({
			pattern: "TODO",
			limit: 5,
		});
	});
});

describe("grepHighlight", () => {
	it("returns the raw string for a literal search (utils escapes it)", () => {
		expect(
			grepHighlight({
				_type: "grepResult",
				text: "",
				pattern: "a.b",
				matchCount: 0,
				literal: true,
			}),
		).toBe("a.b");
	});

	it("compiles a case-sensitive regex by default", () => {
		const re = grepHighlight({ _type: "grepResult", text: "", pattern: "te.t", matchCount: 0 });
		expect(re).toBeInstanceOf(RegExp);
		expect((re as RegExp).flags).toBe("g");
		expect((re as RegExp).test("test")).toBe(true);
	});

	it("adds the i flag when ignoreCase is set", () => {
		const re = grepHighlight({
			_type: "grepResult",
			text: "",
			pattern: "todo",
			matchCount: 0,
			ignoreCase: true,
		});
		expect((re as RegExp).flags).toBe("gi");
	});

	it("falls back to the literal source on an invalid regex", () => {
		expect(grepHighlight({ _type: "grepResult", text: "", pattern: "(", matchCount: 0 })).toBe("(");
	});
});

describe("registerGrepTool", () => {
	it("registers a tool named 'grep'", () => {
		const tools: string[] = [];
		const mockPi: PiPrettyApi = {
			registerTool(t: unknown) {
				tools.push((t as { name: string }).name);
			},
			registerCommand() {},
			on() {},
		};

		registerGrepTool(
			mockPi,
			() => ({ execute: async () => ({ content: [], details: undefined }) }),
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
			},
		);
		expect(tools).toEqual(["grep"]);
	});

	it("restores matching lines when an elapsed card is expanded", () => {
		const registered: { renderResult?: (...args: unknown[]) => MockTextComponent } = {};
		const mockPi: PiPrettyApi = {
			registerTool(tool: unknown) {
				Object.assign(registered, tool);
			},
			registerCommand() {},
			on() {},
		};
		registerGrepTool(
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
		const output = "src/a.ts:1:TODO one\nsrc/b.ts:2:TODO two";
		const result = registered.renderResult?.(
			{
				content: [{ type: "text", text: output }],
				details: {
					_type: "grepResult",
					text: output,
					pattern: "TODO",
					matchCount: 2,
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

		const rendered = result?.getText() ?? "";
		expect(rendered).toContain("src/a.ts:1:");
		expect(rendered).toContain("TODO");
		expect(rendered).toContain("one");
		expect(rendered).toContain("src/b.ts:2:");
		expect(rendered).not.toContain("✓ grep");
	});

	it("frames single-match output like multi-match (no inline row)", () => {
		const registered: { renderResult?: (...args: unknown[]) => MockTextComponent } = {};
		const mockPi: PiPrettyApi = {
			registerTool(tool: unknown) {
				Object.assign(registered, tool);
			},
			registerCommand() {},
			on() {},
		};
		registerGrepTool(
			mockPi,
			() => ({ execute: async () => ({ content: [], details: undefined }) }),
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
				cursorStore: { store: () => "", get: () => undefined } as unknown as CursorStore,
			},
		);
		const theme: ThemeLike = { fg: (_k: string, v: string) => v, bold: (v: string) => v };
		const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
		const result = {
			content: [{ type: "text", text: "src/a.ts:1:foo" }],
			details: {
				_type: "grepResult",
				text: "src/a.ts:1:foo",
				pattern: "foo",
				matchCount: 1,
			} as never,
		};
		const out =
			registered
				.renderResult?.(result, { isPartial: false }, theme, {
					expanded: false,
					isError: false,
					invalidate: () => {},
					state: {},
				} as unknown as RenderContextLike)
				?.getText() ?? "";
		// Single match is framed just like multi — one shape, no inline row.
		expect(out).toContain("─");
		expect(strip(out)).toContain("foo");
		expect(strip(out)).not.toContain("match");
		const multi = {
			content: [{ type: "text", text: "a:1:foo\nb:2:foo\nc:3:foo" }],
			details: {
				_type: "grepResult",
				text: "a:1:foo\nb:2:foo\nc:3:foo",
				pattern: "foo",
				matchCount: 3,
			} as never,
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
		registerGrepTool(
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
		const diagnostic = "regex parse error: unclosed group";
		const result = {
			content: [{ type: "text", text: diagnostic }],
			details: {
				_type: "grepResult",
				text: diagnostic,
				pattern: "(",
				path: "src",
				matchCount: 0,
			},
		};
		const render = (state: Record<string, unknown>, expanded = false) => {
			const component = registered.renderResult?.(result, { isPartial: false }, theme, {
				expanded,
				isError: true,
				invalidate: () => {},
				state,
			} as unknown as RenderContextLike);
			return component?.render(120).join("\n") ?? "";
		};

		expect(render({ timer: 1 })).toContain(diagnostic);
		expect(render({ timer: 1 })).toContain("─");
		expect(render({ collapsed: true })).toContain("✗  grep “(” in src · failed");
		expect(render({ collapsed: true }, true)).toContain(diagnostic);
	});
});
