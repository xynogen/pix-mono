import { describe, expect, it } from "bun:test";
import type { CursorStore, FffState } from "@xynogen/pix-pretty/fff";
import type {
	PiPrettyApi,
	RenderContextLike,
	TextComponentCtor,
	ThemeLike,
} from "@xynogen/pix-pretty/types";
import { applyLsDefaults, DEFAULT_LS_LIMIT, registerLsTool } from "./ls";

class MockTextComponent {
	private text = "";
	setText(v: string) {
		this.text = v;
	}
	getText() {
		return this.text;
	}
}

describe("applyLsDefaults", () => {
	it("applies a conservative default without overriding an explicit limit", () => {
		expect(applyLsDefaults({})).toEqual({ limit: DEFAULT_LS_LIMIT });
		expect(applyLsDefaults({ path: "src", limit: 12 })).toEqual({ path: "src", limit: 12 });
	});
});

describe("registerLsTool", () => {
	it("registers a tool named 'ls'", () => {
		const tools: string[] = [];
		const mockPi: PiPrettyApi = {
			registerTool(t: unknown) {
				tools.push((t as { name: string }).name);
			},
			registerCommand() {},
			on() {},
		};

		registerLsTool(mockPi, () => ({ execute: async () => ({ content: [], details: undefined }) }), {
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
		});
		expect(tools).toEqual(["ls"]);
	});

	it("restores the listing when an elapsed card is expanded", () => {
		const registered: { renderResult?: (...args: unknown[]) => MockTextComponent } = {};
		const mockPi: PiPrettyApi = {
			registerTool(tool: unknown) {
				Object.assign(registered, tool);
			},
			registerCommand() {},
			on() {},
		};
		registerLsTool(mockPi, () => ({ execute: async () => ({ content: [], details: undefined }) }), {
			cwd: process.cwd(),
			sp: (p: string) => p,
			TextComponent: MockTextComponent as unknown as TextComponentCtor,
			fffState: { module: null, finder: null, partialIndex: false, dbDir: null },
			cursorStore: { store: () => "", get: () => undefined } as unknown as CursorStore,
		});
		const theme: ThemeLike = {
			fg: (_key: string, value: string) => value,
			bold: (value: string) => value,
		};
		const result = registered.renderResult?.(
			{
				content: [{ type: "text", text: "alpha.ts\nbravo.ts" }],
				details: {
					_type: "lsResult",
					text: "alpha.ts\nbravo.ts",
					path: ".",
					entryCount: 2,
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

		expect(result?.getText()).toContain("alpha.ts");
		expect(result?.getText()).toContain("bravo.ts");
		expect(result?.getText()).not.toContain("✓ ls");
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
		registerLsTool(mockPi, () => ({ execute: async () => ({ content: [], details: undefined }) }), {
			cwd: process.cwd(),
			sp: (p: string) => p,
			TextComponent: MockTextComponent as unknown as TextComponentCtor,
			fffState: { module: null, finder: null, partialIndex: false, dbDir: null },
			cursorStore: { store: () => "", get: () => undefined } as unknown as CursorStore,
		});
		const theme: ThemeLike = {
			fg: (_key: string, value: string) => value,
			bold: (value: string) => value,
		};
		const diagnostic = "ENOENT: cannot list missing-dir";
		const result = {
			content: [{ type: "text", text: diagnostic }],
			details: { _type: "lsResult", text: diagnostic, path: "missing-dir", entryCount: 0 },
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
		expect(render({ collapsed: true })).toContain("✗  ls missing-dir · failed");
		expect(render({ collapsed: true }, true)).toContain(diagnostic);
	});
});
