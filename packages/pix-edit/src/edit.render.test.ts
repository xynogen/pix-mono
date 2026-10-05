import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { Text } from "@earendil-works/pi-tui";
import { capturePi, makeRenderCtx, makeToolContext } from "@xynogen/pix-pretty/test-utils";
import type { ToolResultLike } from "@xynogen/pix-pretty/types";
import { collapseSection } from "@xynogen/pix-runtime/sections";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";

test("edit captures anchored/exact calls, pending/completed diffs and result states", async () => {
	const fixture = await withUiFixture();
	const env = Object.fromEntries(
		["FORCE_COLOR", "NO_COLOR", "DIFF_SPLIT_MIN_WIDTH", "DIFF_SPLIT_MIN_CODE_WIDTH"].map((key) => [
			key,
			process.env[key],
		]),
	);
	process.env.FORCE_COLOR = "3";
	delete process.env.NO_COLOR;
	delete process.env.DIFF_SPLIT_MIN_WIDTH;
	delete process.env.DIFF_SPLIT_MIN_CODE_WIDTH;
	let highlight: typeof import("@xynogen/pix-pretty/highlight") | undefined;
	let cache = new Map<string, string[]>();
	let chalk: { level: number } | undefined;
	let level = 0;
	try {
		chalk = createRequire(import.meta.resolve("@xynogen/pix-pretty/highlight"))("chalk");
		level = chalk!.level;
		highlight = await import("@xynogen/pix-pretty/highlight");
		cache = new Map(highlight._cache);
		highlight._cache.clear();
		const { registerEditTool } = await import("./edit.ts");
		const { viewportTextConstructor } = await import("@xynogen/pix-pretty/utils");
		const { pi, tool } = capturePi();
		registerEditTool(
			pi,
			() => ({
				execute: async () => {
					throw new Error("Capture must not execute edit");
				},
			}),
			makeToolContext({ TextComponent: viewportTextConstructor(Text) }),
			() => {},
		);
		const theme = roleTheme();
		const rows = (component: { render(width: number): string[] } | undefined) => {
			if (!component) throw new Error("Missing edit renderer");
			return captureRows(component, { width: 80, surface: "host-self" }).join("\n");
		};
		for (const args of [
			{ path: "src/a.ts", edits: [{ op: "replace", pos: "12#ABC", lines: ["  return 2;"] }] },
			{
				path: "src/a.ts",
				edits: [
					{ oldText: "  return 1;\n", newText: "  return 2;\n" },
					{ oldText: "old", newText: "new" },
				],
			},
		])
			expect(rows(tool.renderCall?.(args, theme, makeRenderCtx()))).toMatchSnapshot("call");
		const op = {
			filePath: "src/a.ts",
			oldContent: "  return 1;\n",
			newContent: "  return 2;\n",
			language: "typescript",
			editLine: 12,
		};
		const single: ToolResultLike = {
			content: [{ type: "text", text: "edited" }],
			details: { _type: "editInfo", summary: "+1 -1", ...op },
		};
		const stacked: ToolResultLike = {
			content: single.content,
			details: {
				_type: "multiEditInfo",
				summary: "+2 -2",
				editCount: 2,
				diffLineCount: 4,
				ops: [op, { ...op, editLine: 24 }],
			},
		};
		for (const [name, result] of [
			["single", single],
			["stacked", stacked],
		] as const) {
			let invalidate!: () => void;
			const completed = new Promise<void>((resolve) => {
				invalidate = resolve;
			});
			const ctx = makeRenderCtx({ expanded: true, state: { collapsed: true }, invalidate });
			const pending = tool.renderResult?.(result, { isPartial: false }, theme, ctx);
			try {
				expect(rows(pending)).toMatchSnapshot(`${name} pending`);
			} finally {
				await completed;
			}
			const output = rows(
				tool.renderResult?.(result, { isPartial: false }, theme, {
					...ctx,
					lastComponent: pending,
				}),
			);
			expect(output).toContain("return");
			expect(output).toMatchSnapshot(`${name} completed`);
		}
		const error: ToolResultLike = {
			...single,
			content: [{ type: "text", text: "Stale anchor: 12#ABC. Read the file again." }],
		};
		for (const [name, result, collapsed, expanded, isError, isPartial] of [
			["collapsed", single, true, false, false, false],
			["error expanded", error, true, true, true, false],
			["error collapsed", error, true, false, true, false],
			["error partial", error, false, false, true, true],
			[
				"fallback",
				{ content: [{ type: "text", text: "edited without details" }] },
				false,
				false,
				false,
				false,
			],
		] as const) {
			await fixture.runtime.update(collapseSection, (current) => ({
				...current,
				enabled: collapsed,
				tools: {},
			}));
			expect(
				rows(
					tool.renderResult?.(
						result,
						{ isPartial },
						theme,
						makeRenderCtx({ state: { collapsed }, expanded, isError }),
					),
				),
			).toMatchSnapshot(name);
		}
	} finally {
		if (chalk) chalk.level = level;
		highlight?._cache.clear();
		for (const [key, value] of cache) highlight?._cache.set(key, value);
		for (const [key, value] of Object.entries(env)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await fixture.restore();
	}
});
