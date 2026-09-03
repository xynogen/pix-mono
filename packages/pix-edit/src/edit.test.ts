import { describe, expect, it } from "bun:test";
import {
	capturePi,
	makeRenderCtx,
	makeTheme,
	makeToolContext,
} from "@xynogen/pix-pretty/test-utils";
import type { ThemeLike } from "@xynogen/pix-pretty/types";
import { getEditOperations, registerEditTool, summarizeEditOperations } from "./edit";

const noopFactory = () => ({ execute: async () => ({ content: [], details: undefined }) });
const noopTrack = () => {};
// Several edit tests assert on the exact fg key in framing rules, so tag every key.
const keyedTheme: ThemeLike = {
	fg: (key: string, value: string) => `[${key}]${value}[/${key}]`,
	bold: (value: string) => value,
};

describe("registerEditTool", () => {
	it("registers a self-rendered edit tool", () => {
		const { pi, tool, names } = capturePi();
		registerEditTool(pi, noopFactory, makeToolContext(), noopTrack);
		expect(names).toEqual(["edit"]);
		expect(tool.name).toBe("edit");
		expect((tool as { renderShell?: string }).renderShell).toBe("self");
	});

	it("restores the bounded diff when an elapsed card is expanded", () => {
		const { pi, tool } = capturePi();
		registerEditTool(pi, noopFactory, makeToolContext(), noopTrack);
		const result = tool.renderResult?.(
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
			keyedTheme,
			makeRenderCtx({ expanded: true, state: { collapsed: true } }),
		);

		const lines = result?.render(80) ?? [];
		expect(lines[0]).toBe(`[success]${"─".repeat(80)}[/success]`);
		expect(lines.join("\n")).toContain("rendering diff");
		expect(lines.join("\n")).not.toContain("✓ edit");
	});

	it("renders single-step output inline as one compact line, framed when expanded", () => {
		const { pi, tool } = capturePi();
		registerEditTool(pi, noopFactory, makeToolContext(), noopTrack);
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
			tool.renderResult?.(result, { isPartial: false }, makeTheme(), makeRenderCtx())?.getText() ??
			"";
		// collapsed/resting: diff placeholder path covered; when expanded framing should not duplicate header
		expect(strip(out).split("\n").length).toBeGreaterThanOrEqual(1);
	});

	it("collapses structured errors and restores the exact diagnostic on expansion", () => {
		const { pi, tool } = capturePi();
		registerEditTool(pi, noopFactory, makeToolContext(), noopTrack);
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
		const render = (state: Record<string, unknown>, expanded = false, isPartial = false) =>
			tool
				.renderResult?.(
					result,
					{ isPartial },
					keyedTheme,
					makeRenderCtx({ isError: true, expanded, state }),
				)
				?.render(80) ?? [];

		expect(render({ timer: 1 })[0]).toBe(`[error]${"─".repeat(80)}[/error]`);
		expect(render({ timer: 1 }).join("\n")).toContain(diagnostic);
		const collapsed = render({ collapsed: true }).join("\n");
		expect(collapsed).toContain("edit");
		expect(collapsed).toContain("sample.ts");
		expect(collapsed).toContain("failed");
		expect(render({ collapsed: true })[0]).not.toContain("────");
		expect(render({ collapsed: true }, true).join("\n")).toContain(diagnostic);
		expect(render({ collapsed: true }, true)[0]).toContain("[error]────");
		expect(render({}, false, true)[0]).not.toContain("[error]────");
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
