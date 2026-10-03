import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createReadToolDefinition as piReadDefinition } from "@earendil-works/pi-coding-agent";
import { initHashline } from "@xynogen/pix-runtime/hashline";
import { tempDir } from "@xynogen/pix-runtime/paths";

beforeAll(initHashline);

import {
	capturePi,
	makeRenderCtx,
	makeTheme,
	makeToolContext,
} from "@xynogen/pix-pretty/test-utils";
import type { ToolResultLike } from "@xynogen/pix-pretty/types";
import { applyReadDefaults, DEFAULT_READ_LIMIT, registerReadTool } from "./read";

const noopFactory = () => ({ execute: async () => ({ content: [], details: undefined }) });
const createReadToolDefinition =
	piReadDefinition as unknown as import("@xynogen/pix-pretty/types").ToolFactory<
		import("@earendil-works/pi-coding-agent").ReadToolInput
	>;

describe("applyReadDefaults", () => {
	it("applies a conservative default without overriding an explicit limit", () => {
		expect(applyReadDefaults({ path: "large.ts" })).toEqual({
			path: "large.ts",
			limit: DEFAULT_READ_LIMIT,
		});
		expect(applyReadDefaults({ path: "large.ts", limit: 25 })).toEqual({
			path: "large.ts",
			limit: 25,
		});
	});
});

describe("registerReadTool", () => {
	it("anchors captured source without annotating notices or display details", async () => {
		const cwd = await mkdtemp(join(tempDir(), "hashline-read-"));
		await writeFile(join(cwd, "source.ts"), "\uFEFFa\r\nb\rc\n");
		const { pi, tool } = capturePi();
		registerReadTool(pi, createReadToolDefinition, { ...makeToolContext(), cwd });
		const execute = tool.execute as (...args: unknown[]) => Promise<ToolResultLike>;
		const result = await execute("id", { path: "source.ts", limit: 2 }, undefined, undefined, {
			cwd,
		});
		expect((result.content?.[0] as { text: string }).text).toMatch(
			/^1#[0-9A-F]{3}\|a\n2#[0-9A-F]{3}\|b\n\n\[.*offset=3/,
		);
		expect(result.details).toMatchObject({ content: "a\nb", lineCount: 2 });
	});
	it("keeps pagination anchors stable and caps complete batch lines including annotation bytes", async () => {
		const cwd = await mkdtemp(join(tempDir(), "hashline-pages-"));
		await writeFile(join(cwd, "small.ts"), "a\nb\n");
		await writeFile(join(cwd, "large.ts"), `${"x".repeat(51000)}\ny\n`);
		await writeFile(join(cwd, "other.ts"), "z".repeat(3000));
		const { pi, tool } = capturePi();
		registerReadTool(pi, createReadToolDefinition, { ...makeToolContext(), cwd });
		const execute = tool.execute as (...args: unknown[]) => Promise<ToolResultLike>;
		const getText = (result: ToolResultLike) => (result.content?.[0] as { text: string }).text;
		const full = await execute("id", { path: "small.ts" }, undefined, undefined, { cwd });
		const page = await execute("id", { path: "small.ts", offset: 2 }, undefined, undefined, {
			cwd,
		});
		expect(getText(page)).toBe(getText(full).split("\n")[1]!);
		const batch = await execute("id", { paths: ["large.ts", "other.ts"] }, undefined, undefined, {
			cwd,
		});
		expect(Buffer.byteLength(getText(batch))).toBeLessThanOrEqual(50 * 1024);
		for (const line of getText(batch)
			.split("\n")
			.filter((line) => /^\d+#/.test(line))) {
			expect(line).toMatch(/^\d+#[0-9A-F]{3}\|(?:x{51000}|y|z{3000})$/);
		}
	});
	it("registers a tool named 'read'", () => {
		const { pi, names } = capturePi();
		registerReadTool(pi, noopFactory, makeToolContext());
		expect(names).toEqual(["read"]);
	});

	it("recomputes an async file preview when expanded mode changes", () => {
		const { pi, tool } = capturePi();
		registerReadTool(pi, noopFactory, makeToolContext());
		const state: Record<string, unknown> = { timer: 1 };
		const result = {
			content: [{ type: "text", text: "one\ntwo" }],
			details: {
				_type: "readFile",
				filePath: "sample.ts",
				content: "one\ntwo",
				offset: 1,
				lineCount: 2,
			},
		};
		const ctx = makeRenderCtx({ state });

		tool.renderResult?.(result, undefined, makeTheme(), { ...ctx, expanded: false });
		const collapsedKey = state._rk;
		tool.renderResult?.(result, undefined, makeTheme(), { ...ctx, expanded: true });

		expect(collapsedKey).toBeDefined();
		expect(state._rk).not.toBe(collapsedKey);
	});

	it("collapses structured errors and restores the exact diagnostic on expansion", () => {
		const { pi, tool } = capturePi();
		registerReadTool(pi, noopFactory, makeToolContext());
		const theme = makeTheme();
		const diagnostic = "ENOENT: no such file or directory";
		const result = {
			content: [{ type: "text", text: diagnostic }],
			details: {
				_type: "readFile",
				filePath: "missing.ts",
				content: diagnostic,
				offset: 1,
				lineCount: 1,
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
		expect(render({ collapsed: true })).toContain("✗  read missing.ts · failed");
		expect(render({ collapsed: true }, true)).toContain(diagnostic);
	});

	it("reads multiple paths in one call and caps into a combined batch result", async () => {
		const cwd = await mkdtemp(join(tempDir(), "hashline-batch-"));
		for (const name of ["a.ts", "b.ts"]) await writeFile(join(cwd, name), `content of ${name}`);
		const { pi, tool } = capturePi();
		registerReadTool(pi, createReadToolDefinition, { ...makeToolContext(), cwd });
		const execute = tool.execute as (...args: unknown[]) => Promise<ToolResultLike>;
		const result = await execute("tid", { paths: ["a.ts", "b.ts"] }, undefined, undefined, {});
		const details = result.details as { _type: string; items: unknown[]; index: string };
		expect(details._type).toBe("readBatch");
		expect(details.items).toHaveLength(2);
		const text = result.content?.[0];
		expect(text && "text" in text ? text.text : "").toContain("===== a.ts =====");
		expect(text && "text" in text ? text.text : "").toContain("content of b.ts");
	});

	it("keeps the single-file shape when only one path is given", async () => {
		const cwd = await mkdtemp(join(tempDir(), "hashline-single-"));
		await writeFile(join(cwd, "solo.ts"), "content of solo.ts");
		const { pi, tool } = capturePi();
		registerReadTool(pi, createReadToolDefinition, { ...makeToolContext(), cwd });
		const execute = tool.execute as (...args: unknown[]) => Promise<ToolResultLike>;
		const result = await execute("tid", { path: "solo.ts" }, undefined, undefined, {});
		const details = result.details as { _type: string; filePath: string };
		expect(details._type).toBe("readFile");
		expect(details.filePath).toBe("solo.ts");
	});

	it("frames completed image and fallback results, not partial fallback", () => {
		const { pi, tool } = capturePi();
		registerReadTool(pi, noopFactory, makeToolContext());
		const theme = makeTheme({ tag: false });
		// This test asserts on the exact fg key, so use a key-tagging theme.
		const keyedTheme = {
			fg: (key: string, value: string) => `[${key}]${value}[/]`,
			bold: (value: string) => value,
		} as typeof theme;
		if (!tool.renderResult) throw new Error("renderResult not registered");
		const renderResult = tool.renderResult;
		const render = (result: unknown, isPartial: boolean, expanded = false) =>
			renderResult(result, { isPartial }, keyedTheme, makeRenderCtx({ expanded })).render(24);
		const image = {
			content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
			details: { _type: "readImage", filePath: "image.png", data: "AAAA", mimeType: "image/png" },
		};
		const fallback = { content: [{ type: "text", text: "read complete" }], details: undefined };

		const imageLines = render(image, false);
		expect(imageLines.at(-1)).toBe(`[success]${"- ".repeat(12)}[/]`);
		const fallbackLines = render(fallback, false);
		expect(fallbackLines[0]).toContain("read complete");
		expect(fallbackLines.at(-1)).toBe(`[success]${"- ".repeat(12)}[/]`);
		expect(render(fallback, false, true).at(-1)).toBe(`[success]${"- ".repeat(12)}[/]`);
		expect(render(fallback, true)).toEqual([expect.stringContaining("read complete")]);
	});
});
