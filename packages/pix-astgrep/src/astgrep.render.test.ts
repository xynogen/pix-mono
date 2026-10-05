import { expect, test } from "bun:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { makeRenderCtx } from "@xynogen/pix-pretty/test-utils";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";
import registerAstGrep from "./astgrep.ts";

test("AST captures six default host-box tools without executing the engine", async () => {
	const fixture = await withUiFixture();
	try {
		const tools: ToolDefinition[] = [];
		registerAstGrep({
			registerTool: (tool: ToolDefinition) => tools.push(tool),
		} as unknown as ExtensionAPI);
		expect(tools.map((tool) => tool.name)).toEqual([
			"ast_grep_search",
			"ast_grep_replace",
			"ast_grep_outline",
			"read_symbol",
			"read_enclosing",
			"symbol_search",
		]);
		const theme = roleTheme();
		const rows = (component: { render(width: number): string[] } | undefined) => {
			if (!component) throw new Error("Missing AST renderer");
			return captureRows(component, { width: 80, surface: "host-box" }).join("\n");
		};
		const args = [
			{ pattern: "greet($A)", lang: "typescript" },
			{ pattern: "greet($A)", rewrite: "welcome($A)" },
			{ path: "src" },
			{ path: "src/a.ts", symbol: "greet" },
			{ path: "src/a.ts", line: 12 },
			{ query: "greet user" },
		];
		const bodies = [
			"src/a.ts:12:3  greet(user)",
			"Preview: 1 edit(s) in 1 file(s). Set apply=true to write.\n--- src/a.ts\n+++ src/a.ts\n-12: greet(user)\n+12: welcome(user)",
			"src/a.ts\n  1: function_declaration  greet\n  8: class_declaration  Widget",
			"src/a.ts:1  greet\nfunction greet(user: string) {\n  return user;\n}\n",
			"src/a.ts:1  greet\nfunction greet(user: string) {\n  return user;\n}",
			"src/a.ts  (3)\nsrc/b.ts  (1)",
		];
		for (const [index, tool] of tools.entries()) {
			expect((tool as { renderShell?: string }).renderShell).toBeUndefined();
			expect(
				rows(tool.renderCall?.(args[index], theme as never, makeRenderCtx() as never)),
			).toMatchSnapshot(`${tool.name} call`);
			expect(
				rows(
					tool.renderResult?.(
						{ content: [{ type: "text", text: bodies[index]! }], details: { outcome: "success" } },
						{ isPartial: false, expanded: false },
						theme as never,
						makeRenderCtx() as never,
					),
				),
			).toMatchSnapshot(`${tool.name} body`);
		}
		const replace = tools[1]!;
		expect(
			rows(
				replace.renderCall?.({ ...args[1], apply: true }, theme as never, makeRenderCtx() as never),
			),
		).toMatchSnapshot("replace apply");
		const search = tools[0]!;
		for (const [name, details, isError, isPartial, text] of [
			["empty", { outcome: "empty" }, false, false, "No matches in 2 file(s)."],
			["context error", { outcome: "success" }, true, false, "Cannot read src/a.ts."],
			["detail error", { outcome: "error" }, false, false, "ast-grep engine unavailable"],
			["partial", { outcome: "success" }, false, true, "src/a.ts:12:3  greet(user)"],
			["no details", undefined, false, false, "No matches."],
		] as const) {
			expect(
				rows(
					search.renderResult?.(
						{ content: [{ type: "text", text }], details },
						{ expanded: false, isPartial },
						theme as never,
						makeRenderCtx({ isError }) as never,
					),
				),
			).toMatchSnapshot(name);
		}
	} finally {
		await fixture.restore();
	}
});
