import { describe, expect, it } from "bun:test";
import {
	capturePi,
	makeRenderCtx,
	makeTheme,
	makeToolContext,
} from "@xynogen/pix-pretty/test-utils";
import type { ThemeLike } from "@xynogen/pix-pretty/types";
import { registerWriteTool } from "./write";

const noopFactory = () => ({ execute: async () => ({ content: [], details: undefined }) });
const noopTrack = () => {};

describe("registerWriteTool", () => {
	it("registers a tool named 'write'", () => {
		const { pi, names } = capturePi();
		registerWriteTool(pi, noopFactory, makeToolContext(), noopTrack);
		expect(names).toEqual(["write"]);
	});

	it("recomputes a new-file result preview when expanded mode changes", () => {
		const { pi, tool } = capturePi();
		registerWriteTool(pi, noopFactory, makeToolContext(), noopTrack);
		const theme = makeTheme();
		const state: Record<string, unknown> = { timer: 1 };
		const result = {
			content: [{ type: "text", text: "written" }],
			details: { _type: "new", lines: 2, content: "one\ntwo", filePath: "sample.ts" },
		};
		const ctx = makeRenderCtx({ state });

		tool.renderResult?.(result, undefined, theme, { ...ctx, expanded: false });
		const collapsedKey = state._nfk;
		tool.renderResult?.(result, undefined, theme, { ...ctx, expanded: true });

		expect(collapsedKey).toBeDefined();
		expect(state._nfk).not.toBe(collapsedKey);

		const callState: Record<string, unknown> = {};
		const callCtx = makeRenderCtx({ state: callState });
		tool.renderCall?.({ path: "definitely-new-preview.ts", content: "one\ntwo" }, theme, {
			...callCtx,
			expanded: false,
		});
		const previewKey = callState._previewKey;
		tool.renderCall?.({ path: "definitely-new-preview.ts", content: "one\ntwo" }, theme, {
			...callCtx,
			expanded: true,
		});
		expect(previewKey).toBeDefined();
		expect(callState._previewKey).not.toBe(previewKey);
	});

	it("collapses structured errors and restores the exact diagnostic on expansion", () => {
		const { pi, tool } = capturePi();
		registerWriteTool(pi, noopFactory, makeToolContext(), noopTrack);
		// This test asserts on the exact fg key in framing rules, so tag every key.
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
			tool
				.renderResult?.(
					result,
					{ isPartial },
					theme,
					makeRenderCtx({ isError: true, expanded, state }),
				)
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
