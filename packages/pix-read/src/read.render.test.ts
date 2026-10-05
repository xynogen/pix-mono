import { expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Text } from "@earendil-works/pi-tui";
import { capturePi, makeRenderCtx, makeToolContext } from "@xynogen/pix-pretty/test-utils";
import type { ToolResultLike } from "@xynogen/pix-pretty/types";
import { collapseSection } from "@xynogen/pix-runtime/sections";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";

it("captures registered read pending, completed, expanded and non-text states", async () => {
	const fixture = await withUiFixture();
	const color = process.env.FORCE_COLOR;
	const pending: Promise<void>[] = [];
	const timers: ReturnType<typeof setTimeout>[] = [];
	let restoreCache = () => {};
	try {
		const { registerReadTool } = await import("./read");
		const { viewportTextConstructor } = await import("@xynogen/pix-pretty/utils");
		const { _cache } = await import("@xynogen/pix-pretty/highlight");
		const cache = new Map(_cache);
		restoreCache = () => {
			_cache.clear();
			for (const [key, value] of cache) _cache.set(key, value);
		};
		const { pi, tool } = capturePi();
		registerReadTool(
			pi,
			() => ({
				execute: async () => {
					throw new Error("Capture must not execute read");
				},
			}),
			makeToolContext({ cwd: fixture.agentDir, TextComponent: viewportTextConstructor(Text) }),
		);
		expect(tool.renderShell).toBe("self");
		const theme = roleTheme();
		const rows = (component: { render(width: number): string[] } | undefined) => {
			if (!component) throw new Error("Missing read renderer");
			return captureRows(component, { width: 80, surface: "host-self" });
		};
		const file = (content: string): ToolResultLike => ({
			content: [{ type: "text", text: content }],
			details: {
				_type: "readFile",
				filePath: "sample.ts",
				content,
				offset: 7,
				lineCount: content.split("\n").length,
			},
		});
		const captures: Record<string, string[]> = {};
		captures.call = rows(
			tool.renderCall?.({ path: "sample.ts", offset: 7, limit: 4 }, theme, makeRenderCtx()),
		);
		const longLine = `const text = "${"x".repeat(90)}END";`;
		const result = file(`const count = 3;\n\t// tab and trailing spaces  \n\n${longLine}`);
		const state: Record<string, unknown> = {};
		const preview = async (expanded: boolean) => {
			let invalidate!: () => void;
			const completed = new Promise<void>((resolve, reject) => {
				invalidate = resolve;
				timers.push(
					setTimeout(() => reject(new Error("Preview did not invalidate within 2000 ms")), 2000),
				);
			});
			pending.push(completed);
			const context = makeRenderCtx({ state, expanded, invalidate });
			const component = tool.renderResult?.(result, { isPartial: false }, theme, context);
			if (!component) throw new Error("Missing read renderer");
			captures[expanded ? "expandedPending" : "pending"] = rows(component);
			await completed;
			return rows(
				tool.renderResult?.(result, { isPartial: false }, theme, {
					...context,
					lastComponent: component,
				}),
			);
		};
		captures.completed = await preview(false);
		const key = state._rk;
		captures.expanded = await preview(true);
		expect(state._rk).not.toBe(key);
		expect(captures.completed.join("\n")).toContain("<syntaxKeyword>const</syntaxKeyword>");
		expect(captures.expanded.join("\n")).toContain("END");
		const render = async (
			value: ToolResultLike,
			{ collapsed = false, expanded = false, isError = false, isPartial = false } = {},
		) => {
			await fixture.runtime.update(collapseSection, (current) => ({
				...current,
				enabled: collapsed,
				tools: {},
			}));
			const renderState = { collapsed };
			const output = rows(
				tool.renderResult?.(
					value,
					{ isPartial },
					theme,
					makeRenderCtx({ state: renderState, expanded, isError }),
				),
			);
			expect(renderState).toEqual({ collapsed });
			return output;
		};
		captures.collapsed = await render(result, { collapsed: true });
		const image: ToolResultLike = {
			content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
			details: { _type: "readImage", filePath: "image.png", data: "AAAA", mimeType: "image/png" },
		};
		captures.image = await render(image);
		captures.collapsedImage = await render(image, { collapsed: true });
		expect(image.content).toEqual([{ type: "image", data: "AAAA", mimeType: "image/png" }]);
		captures.batch = await render({
			content: [],
			details: {
				_type: "readBatch",
				index: "3 files",
				items: [
					{ _type: "readFile", filePath: "one.txt", content: "one", offset: 1, lineCount: 1 },
					{ _type: "readImage", filePath: "image.png", data: "AAAA", mimeType: "image/png" },
					{ _type: "readError", filePath: "missing.txt", message: "ENOENT: missing.txt" },
				],
			},
		});
		const error = file("ENOENT: sample.ts");
		captures.error = await render(error, { isError: true });
		captures.collapsedError = await render(error, { collapsed: true, isError: true });
		captures.expandedError = await render(error, {
			collapsed: true,
			expanded: true,
			isError: true,
		});
		const fallback = {
			content: [{ type: "text" as const, text: "read complete" }],
			details: undefined,
		};
		captures.fallback = await render(fallback);
		captures.partial = await render(fallback, { isPartial: true });
		expect(captures.image?.at(-1)).toBe(`<success>${"- ".repeat(40)}</success>`);
		expect(captures.error?.at(-1)).toBe(`<error>${"- ".repeat(40)}</error>`);
		// ponytail: local renderer captures do not replace anchored execution or raw-byte checks.
		expect(
			stripVTControlCharacters(
				result.content[0] && "text" in result.content[0] ? result.content[0].text : "",
			),
		).toBe((result.details as { content: string }).content);
		expect(captures).toMatchSnapshot();
	} finally {
		try {
			await Promise.all(pending);
		} finally {
			for (const timer of timers) clearTimeout(timer);
			restoreCache();
			if (color === undefined) delete process.env.FORCE_COLOR;
			else process.env.FORCE_COLOR = color;
			await fixture.restore();
		}
	}
});
