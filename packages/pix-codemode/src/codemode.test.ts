import { describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	capturePi,
	MockTextComponent,
	makeRenderCtx,
	makeTheme,
} from "@xynogen/pix-pretty/test-utils";
import type { ThemeLike } from "@xynogen/pix-pretty/types";
import { createIsolatedRuntime } from "@xynogen/pix-runtime/testing";
import { renderCall, renderResult } from "./codemode.ts";
import extension from "./extension.ts";

const theme: ThemeLike = { ...makeTheme(), fg: (key, text) => `<${key}>${text}</${key}>` };
const options = { expanded: false, isPartial: false };
const result = (text = '{"ok":true}', failed = false) => ({
	content: [
		{
			type: "text" as const,
			text: `Script ${failed ? "failed" : "completed"}\nWall time 0.25 seconds\nOutput:\n`,
		},
		{ type: "text" as const, text },
	],
	details: {},
});
const ctx = (state = {}) => ({ ...makeRenderCtx(), state, invalidate: () => {} });
const rendered = (component: { render?: (width: number) => string[] }) =>
	stripVTControlCharacters(
		component
			.render?.(100)
			.map((line) => line.trimEnd())
			.join("\n") ?? "",
	);

describe("codemode renderer", () => {
	test("shows the script, preview and full call", async () => {
		const context = ctx();
		const code = Array.from({ length: 20 }, (_, i) => `const n${i} = ${i};`).join("\n");
		renderCall({ code }, theme, context);
		await Promise.resolve();
		const preview = rendered(renderCall({ code }, theme, context));
		expect(preview).toContain("<toolTitle>codemode</toolTitle>");
		expect(preview).toContain("const");
		expect(preview).toContain("… +4 lines");
		const full = rendered(renderCall({ code }, theme, { ...context, expanded: true }));
		expect(full).toContain("n19");
	});

	test("strips the header, formats JSON and frames success", async () => {
		const context = ctx();
		renderResult(result(), options, theme, context);
		await Promise.resolve();
		const lines = rendered(renderResult(result(), options, theme, context));
		expect(lines).toMatch(/\{\n.*"ok".*true.*\n.*\}/);
		expect(lines).toMatch(/<success>[- ─]+<\/success>$/);
		expect(lines).not.toContain("Script completed");
	});

	test("collapses success, hides its call, and keeps errors visible", () => {
		const runtime = createIsolatedRuntime();
		try {
			const context = ctx({ collapsed: true });
			const row = rendered(renderResult(result(), options, theme, context));
			expect(row).toMatch(/codemode.*0 calls.*3 lines/);
			expect(rendered(renderCall({ code: "return 1;" }, theme, context))).toBe("");
			const error = rendered(
				renderResult(result("Script error:\nbad input", true), options, theme, context),
			);
			expect(error).toContain("<error>Script error:</error>");
			expect(error).toMatch(/<error>[- ─]+<\/error>$/);
		} finally {
			runtime.cleanup();
		}
	});

	test("shows partial calls without a frame and keeps raw unknown output", () => {
		const calls = Array.from({ length: 10 }, (_, i) => ({
			id: `${i}`,
			name: "read",
			args: `file${i}`,
			status: "running" as const,
		}));
		const partial = rendered(
			renderResult(
				{ ...result(), details: { calls } },
				{ ...options, isPartial: true },
				theme,
				ctx(),
			),
		);
		expect(partial).toContain("… +2 earlier calls");
		expect(partial).toContain("file9");
		expect(partial).not.toContain("<success>");
		const raw = rendered(
			renderResult(
				{
					content: [{ type: "text", text: "new host header\nraw output" }],
					details: { fullOutputPath: "/tmp/full.txt" },
				},
				options,
				theme,
				ctx(),
			),
		);
		expect(raw).toContain("new host header");
		expect(raw).toContain("Full output: /tmp/full.txt");
	});

	test("reuses a previous framed preview and expands without clipping", () => {
		const context = ctx();
		const first = renderResult(result(), options, theme, context);
		const reused = renderResult(result("plain"), options, theme, {
			...context,
			lastComponent: first,
		});
		expect(rendered(reused)).toContain("plain");
		const full = renderResult(
			result("x".repeat(150)),
			{ ...options, expanded: true },
			theme,
			context,
		);
		expect(full.render?.(100).length).toBeGreaterThan(2);
	});
});

test("extension preserves the native definition and schema identity", () => {
	const captured = capturePi();
	const native = capturePi();
	createCodemodeExtension()(native.pi as unknown as ExtensionAPI);
	extension(captured.pi as unknown as ExtensionAPI);
	expect(captured.names).toEqual(["codemode"]);
	for (const key of Object.keys(native.tool)) {
		if (["renderCall", "renderResult", "execute", "prepareLoadout"].includes(key)) continue;
		expect(captured.tool[key]).toEqual(native.tool[key]);
	}
	expect(captured.tool.parameters).toBe(native.tool.parameters);
	expect(captured.tool.defaultActive).toBe(false);
	expect(captured.tool.renderCall === (renderCall as unknown)).toBe(true);
	expect(captured.tool.renderResult === (renderResult as unknown)).toBe(true);
	expect(captured.tool.renderShell).toBe("self");
	expect(typeof captured.tool.execute).toBe("function");
	expect(new MockTextComponent("ok").getText()).toBe("ok");
});
