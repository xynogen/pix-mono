import { expect, test } from "bun:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { makeRenderCtx } from "@xynogen/pix-pretty/test-utils";
import { collapseSection } from "@xynogen/pix-runtime/sections";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";
import registerHunk from "./index.ts";

test("hunk captures local self-shell states without running commands", async () => {
	const fixture = await withUiFixture();
	try {
		let tool!: ToolDefinition;
		registerHunk(
			{
				registerTool: (definition: ToolDefinition) => {
					tool = definition;
				},
			} as unknown as ExtensionAPI,
			async () => {
				throw new Error("Capture must not run hunk");
			},
		);
		const theme = roleTheme();
		const rows = (component: { render(width: number): string[] } | undefined, width = 80) => {
			if (!component) throw new Error("Missing hunk renderer");
			return captureRows(component, { width, surface: "host-self" }).join("\n");
		};
		const args = {
			ops: [
				{ action: "navigate", file: "src/a.ts", hunk: 1 },
				{ action: "comment", file: "src/a.ts", newLine: 13, summary: "Hidden body" },
			],
		};
		expect(rows(tool.renderCall?.(args, theme as never, makeRenderCtx() as never))).toMatchSnapshot(
			"call",
		);
		expect(
			rows(
				tool.renderCall?.(
					args,
					theme as never,
					makeRenderCtx({ state: { collapsed: true } }) as never,
				),
			),
		).toBe("");
		const results = [
			{ action: "navigate", ok: true, data: { result: { filePath: "src/a.ts", hunkIndex: 0 } } },
			{
				action: "comment",
				ok: true,
				data: {
					result: {
						commentId: "internal-c17",
						filePath: "src/a.ts",
						line: 13,
						side: "new",
						summary: "Hidden body",
					},
				},
			},
		];
		for (const [name, collapsed, expanded, isPartial, failed, width] of [
			["collapsed", true, false, false, false, 80],
			["expanded", true, true, false, false, 80],
			["partial", false, true, true, false, 80],
			["collapsed error", true, false, false, true, 80],
			["expanded error", true, true, false, true, 80],
			["long error", false, true, false, true, 120],
		] as const) {
			fixture.setWidth(width);
			await fixture.runtime.update(collapseSection, (current) => ({
				...current,
				enabled: collapsed,
				tools: {},
			}));
			const details = {
				_type: "hunkResult",
				outcome: failed ? "error" : "success",
				results: failed
					? [
							{
								action: "list",
								ok: false,
								error: width === 120 ? `session gone: ${"detail ".repeat(20)}END` : "session gone",
							},
						]
					: results,
			};
			const output = rows(
				tool.renderResult?.(
					{ content: [{ type: "text", text: "Full model output stays separate" }], details },
					{ expanded, isPartial },
					theme as never,
					makeRenderCtx({ expanded, state: { collapsed } }) as never,
				),
				width,
			);
			expect(output).not.toContain("internal-c17");
			expect(output).not.toContain("Hidden body");
			expect(output).toMatchSnapshot(name);
		}
		const fallback = rows(
			tool.renderResult?.(
				{ content: [{ type: "text", text: "raw fallback\n  detail" }], details: undefined },
				{ expanded: false, isPartial: false },
				theme as never,
				makeRenderCtx() as never,
			),
		);
		expect(fallback.split("\n").at(-1)).toBe(`<success>${"- ".repeat(40)}</success>`);
		expect(
			rows(
				tool.renderResult?.(
					{ content: [{ type: "text", text: "raw fallback\n  detail" }], details: undefined },
					{ expanded: false, isPartial: false },
					theme as never,
					makeRenderCtx() as never,
				),
			),
		).toMatchSnapshot("no details");
	} finally {
		await fixture.restore();
	}
});
