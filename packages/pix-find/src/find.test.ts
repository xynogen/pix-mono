import { describe, expect, it } from "bun:test";
import type { CursorStore, FffState } from "@xynogen/pix-pretty/fff";
import type {
	PiPrettyApi,
	RenderContextLike,
	TextComponentCtor,
	ThemeLike,
} from "@xynogen/pix-pretty/types";
import { applyFindDefaults, DEFAULT_FIND_LIMIT, globHighlight, registerFindTool } from "./find";

describe("globHighlight", () => {
	it("keeps literal runs from a glob as case-insensitive alternatives", () => {
		const re = globHighlight("**/*.test.ts");
		expect(re).toBeInstanceOf(RegExp);
		expect((re as RegExp).flags).toBe("gi");
		expect("foo.test.ts".match(re as RegExp)).not.toBeNull();
	});

	it("highlights the extension of a simple glob", () => {
		expect("app.ts".match(globHighlight("*.ts") as RegExp)?.[0]).toBe(".ts");
	});

	it("returns undefined when the glob has no meaningful literal run", () => {
		expect(globHighlight("*")).toBeUndefined();
	});
});

class MockTextComponent {
	private text = "";
	setText(v: string) {
		this.text = v;
	}
	getText() {
		return this.text;
	}
}

describe("applyFindDefaults", () => {
	it("applies a conservative default without overriding an explicit limit", () => {
		expect(applyFindDefaults({ pattern: "**/*.ts" })).toEqual({
			pattern: "**/*.ts",
			limit: DEFAULT_FIND_LIMIT,
		});
		expect(applyFindDefaults({ pattern: "**/*.ts", limit: 8 })).toEqual({
			pattern: "**/*.ts",
			limit: 8,
		});
	});
});

describe("registerFindTool", () => {
	it("registers a tool named 'find'", () => {
		const tools: string[] = [];
		const mockPi: PiPrettyApi = {
			registerTool(t: unknown) {
				tools.push((t as { name: string }).name);
			},
			registerCommand() {},
			on() {},
		};

		registerFindTool(
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
		expect(tools).toEqual(["find"]);
	});

	it("restores result paths when an elapsed card is expanded", () => {
		const registered: { renderResult?: (...args: unknown[]) => MockTextComponent } = {};
		const mockPi: PiPrettyApi = {
			registerTool(tool: unknown) {
				Object.assign(registered, tool);
			},
			registerCommand() {},
			on() {},
		};
		registerFindTool(
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
		const result = registered.renderResult?.(
			{
				content: [{ type: "text", text: "src/one.ts\nsrc/two.ts" }],
				details: {
					_type: "findResult",
					text: "src/one.ts\nsrc/two.ts",
					pattern: "**/*.ts",
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

		const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
		const shown = strip(result?.getText() ?? "");
		expect(shown).toContain("src/one.ts");
		expect(shown).toContain("src/two.ts");
		// No floating count header in the framed view — the collapsed row carries it.
		expect(shown).not.toContain("2 files");
	});

	it("frames single-file output like multi-file (no inline row)", () => {
		const registered: { renderResult?: (...args: unknown[]) => MockTextComponent } = {};
		const mockPi: PiPrettyApi = {
			registerTool(tool: unknown) {
				Object.assign(registered, tool);
			},
			registerCommand() {},
			on() {},
		};
		registerFindTool(
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
			content: [{ type: "text", text: "src/a.ts" }],
			details: { _type: "findResult", text: "src/a.ts", pattern: "*.ts", matchCount: 1 } as never,
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
		// Single result is framed just like multi — one shape, no inline row.
		expect(out).toContain("─");
		expect(strip(out)).toContain("src/a.ts");
		expect(strip(out)).not.toContain("file");
		const multi = {
			content: [{ type: "text", text: "a.ts\nb.ts\nc.ts" }],
			details: {
				_type: "findResult",
				text: "a.ts\nb.ts\nc.ts",
				pattern: "*.ts",
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
		registerFindTool(
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
		const diagnostic = "Invalid glob pattern: [";
		const result = {
			content: [{ type: "text", text: diagnostic }],
			details: {
				_type: "findResult",
				text: diagnostic,
				pattern: "[",
				path: "src",
				matchCount: 0,
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
		expect(render({ collapsed: true })).toContain("✗  find [ in src · failed");
		expect(render({ collapsed: true }, true)).toContain(diagnostic);
	});
});
