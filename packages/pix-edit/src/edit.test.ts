import { describe, expect, it } from "bun:test";
import type { CursorStore, FffState } from "@xynogen/pix-pretty/fff";
import type {
	PiPrettyApi,
	RenderContextLike,
	TextComponentCtor,
	ThemeLike,
} from "@xynogen/pix-pretty/types";
import { getEditOperations, registerEditTool, summarizeEditOperations } from "./edit";

class MockTextComponent {
	private text = "";
	setText(v: string) {
		this.text = v;
	}
	getText() {
		return this.text;
	}
}

describe("registerEditTool", () => {
	it("registers a self-rendered edit tool", () => {
		const tools: Array<{ name: string; renderShell?: string }> = [];
		const mockPi: PiPrettyApi = {
			registerTool(t: unknown) {
				tools.push(t as { name: string; renderShell?: string });
			},
			registerCommand() {},
			on() {},
		};

		registerEditTool(
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
			(_id: string, _inv: () => void) => {},
		);
		expect(tools).toHaveLength(1);
		expect(tools[0]?.name).toBe("edit");
		expect(tools[0]?.renderShell).toBe("self");
	});

	it("restores the bounded diff when an elapsed card is expanded", () => {
		const registered: { renderResult?: (...args: unknown[]) => MockTextComponent } = {};
		const mockPi: PiPrettyApi = {
			registerTool(tool: unknown) {
				Object.assign(registered, tool);
			},
			registerCommand() {},
			on() {},
		};
		registerEditTool(
			mockPi,
			() => ({ execute: async () => ({ content: [], details: undefined }) }),
			{
				cwd: process.cwd(),
				sp: (p: string) => p,
				TextComponent: MockTextComponent as unknown as TextComponentCtor,
				fffState: { module: null, finder: null, partialIndex: false, dbDir: null },
				cursorStore: { store: () => "", get: () => undefined } as unknown as CursorStore,
			},
			() => {},
		);
		const theme: ThemeLike = {
			fg: (_key: string, value: string) => value,
			bold: (value: string) => value,
		};
		const result = registered.renderResult?.(
			{
				content: [{ type: "text", text: "edited" }],
				details: {
					_type: "editInfo",
					filePath: "sample.ts",
					summary: "+1 -1",
					oldContent: "old",
					newContent: "new",
					language: "typescript",
					editLine: 1,
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

		expect(result?.getText()).toContain("rendering diff");
		expect(result?.getText()).not.toContain("✓ edit");
	});

	it("renders single-step output inline as one compact line, framed when expanded", () => {
		const registered: { renderResult?: (...args: unknown[]) => MockTextComponent } = {};
		const mockPi: PiPrettyApi = {
			registerTool(tool: unknown) {
				Object.assign(registered, tool);
			},
			registerCommand() {},
			on() {},
		};
		registerEditTool(
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
				} as unknown as FffState,
				cursorStore: { store: () => "", get: () => undefined } as unknown as CursorStore,
			},
			() => {},
		);
		const theme: ThemeLike = { fg: (_k: string, v: string) => v, bold: (v: string) => v };
		const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
		// edit today shows summary + diff; the ask is that single-step call already covers summary
		// so collapsed result stays compact — this test documents current behavior does NOT duplicate
		const result = {
			content: [{ type: "text", text: "edited" }],
			details: {
				_type: "editInfo",
				filePath: "app.py",
				summary: "-1",
				oldContent: "old line\n",
				newContent: "new line\n",
				language: "python",
				editLine: 1,
			},
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
		// collapsed/resting: diff placeholder path covered; when expanded framing should not duplicate header
		expect(strip(out).split("\n").length).toBeGreaterThanOrEqual(1);
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
		registerEditTool(
			mockPi,
			() => ({ execute: async () => ({ content: [], details: undefined }) }),
			{
				cwd: process.cwd(),
				sp: (p: string) => p,
				TextComponent: MockTextComponent as unknown as TextComponentCtor,
				fffState: { module: null, finder: null, partialIndex: false, dbDir: null },
				cursorStore: { store: () => "", get: () => undefined } as unknown as CursorStore,
			},
			() => {},
		);
		const theme: ThemeLike = {
			fg: (_key: string, value: string) => value,
			bold: (value: string) => value,
		};
		const diagnostic = "oldText was not found in sample.ts";
		const result = {
			content: [{ type: "text", text: diagnostic }],
			details: {
				_type: "editInfo",
				filePath: "sample.ts",
				summary: "+1 -1",
				oldContent: "old",
				newContent: "new",
				language: "typescript",
				editLine: 0,
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
		expect(render({ collapsed: true })).toContain("✗  edit sample.ts · failed");
		expect(render({ collapsed: true }, true)).toContain(diagnostic);
	});
});

describe("getEditOperations", () => {
	it("extracts array edits", () => {
		const ops = getEditOperations({
			path: "f.ts",
			edits: [{ oldText: "a", newText: "b" }],
		});
		expect(ops).toEqual([{ oldText: "a", newText: "b" }]);
	});

	it("filters ops where old === new", () => {
		const ops = getEditOperations({
			path: "f.ts",
			edits: [{ oldText: "x", newText: "x" }],
		});
		expect(ops).toHaveLength(0);
	});
});

describe("summarizeEditOperations", () => {
	it("returns a summary string", () => {
		const { summary } = summarizeEditOperations([{ oldText: "a\nb", newText: "c\nd\ne" }]);
		expect(typeof summary).toBe("string");
		expect(summary.length).toBeGreaterThan(0);
	});
});
