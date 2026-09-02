import { describe, expect, it } from "bun:test";
import type { CursorStore, FffState } from "@xynogen/pix-pretty/fff";
import type {
	PiPrettyApi,
	RenderContextLike,
	TextComponentCtor,
	ThemeLike,
} from "@xynogen/pix-pretty/types";
import { registerWriteTool } from "./write";

class MockTextComponent {
	private text = "";
	setText(v: string) {
		this.text = v;
	}
	getText() {
		return this.text;
	}
	render(_width: number) {
		return this.text.split("\n");
	}
	invalidate() {}
}

describe("registerWriteTool", () => {
	it("registers a tool named 'write'", () => {
		const tools: string[] = [];
		const mockPi: PiPrettyApi = {
			registerTool(t: unknown) {
				tools.push((t as { name: string }).name);
			},
			registerCommand() {},
			on() {},
		};

		registerWriteTool(
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
		expect(tools).toEqual(["write"]);
	});

	it("recomputes a new-file result preview when expanded mode changes", () => {
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
		registerWriteTool(
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
		const state: Record<string, unknown> = { timer: 1 };
		const result = {
			content: [{ type: "text", text: "written" }],
			details: {
				_type: "new",
				lines: 2,
				content: "one\ntwo",
				filePath: "sample.ts",
			},
		};
		const baseCtx = {
			isError: false,
			invalidate: () => {},
			state,
		} as unknown as RenderContextLike;

		registered.renderResult?.(result, undefined, theme, { ...baseCtx, expanded: false });
		const collapsedKey = state._nfk;
		registered.renderResult?.(result, undefined, theme, { ...baseCtx, expanded: true });

		expect(collapsedKey).toBeDefined();
		expect(state._nfk).not.toBe(collapsedKey);

		const callState: Record<string, unknown> = {};
		registered.renderCall?.({ path: "definitely-new-preview.ts", content: "one\ntwo" }, theme, {
			...baseCtx,
			state: callState,
			expanded: false,
		});
		const previewKey = callState._previewKey;
		registered.renderCall?.({ path: "definitely-new-preview.ts", content: "one\ntwo" }, theme, {
			...baseCtx,
			state: callState,
			expanded: true,
		});
		expect(previewKey).toBeDefined();
		expect(callState._previewKey).not.toBe(previewKey);
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
		registerWriteTool(
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
			fg: (key: string, value: string) => `[${key}]${value}[/${key}]`,
			bold: (value: string) => value,
		};
		const diagnostic = "EACCES: permission denied, open 'locked.ts'";
		const result = {
			content: [{ type: "text", text: diagnostic }],
			details: { _type: "new", lines: 1, content: "value", filePath: "locked.ts" },
		};
		const render = (state: Record<string, unknown>, expanded = false, isPartial = false) =>
			registered
				.renderResult?.(result, { isPartial }, theme, {
					expanded,
					isError: true,
					invalidate: () => {},
					state,
				} as unknown as RenderContextLike)
				?.render(80) ?? [];

		expect(render({ timer: 1 })[0]).toBe(`[error]${"─".repeat(80)}[/error]`);
		expect(render({ timer: 1 }).join("\n")).toContain(diagnostic);
		const collapsed = render({ collapsed: true }).join("\n");
		expect(collapsed).toContain("write");
		expect(collapsed).toContain("locked.ts");
		expect(collapsed).toContain("failed");
		expect(render({ collapsed: true })[0]).not.toContain("────");
		expect(render({ collapsed: true }, true).join("\n")).toContain(diagnostic);
		expect(render({ collapsed: true }, true)[0]).toContain("[error]────");
		expect(render({}, false, true)[0]).not.toContain("[error]────");
	});
});
