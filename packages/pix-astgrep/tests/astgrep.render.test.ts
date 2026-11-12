import { expect, test } from "bun:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { makeRenderCtx } from "@xynogen/pix-pretty/test-utils";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";
import registerAstGrep from "../src/astgrep.ts";

test("AST captures the six actions of the default host-box ast tool without executing the engine", async () => {
	const fixture = await withUiFixture();
	try {
		const tools: ToolDefinition[] = [];
		registerAstGrep({
			registerTool: (tool: ToolDefinition) => tools.push(tool),
		} as unknown as ExtensionAPI);
		expect(tools.map((tool) => tool.name)).toEqual(["ast"]);
		const tool = tools[0]!;
		expect((tool as { renderShell?: string }).renderShell).toBeUndefined();
		const theme = roleTheme();
		const rows = (component: { render(width: number): string[] } | undefined) => {
			if (!component) throw new Error("Missing AST renderer");
			return captureRows(component, { width: 80, surface: "host-box" }).join("\n");
		};
		// Renderers route by the call's action, so every context carries the call args.
		const ctx = (args: object, overrides: Parameters<typeof makeRenderCtx>[0] = {}) =>
			({ ...makeRenderCtx(overrides), args }) as never;
		const calls = [
			{ action: "search", pattern: "greet($A)", lang: "typescript" },
			{ action: "replace", pattern: "greet($A)", rewrite: "welcome($A)" },
			{ action: "outline", path: "src" },
			{ action: "symbol", path: "src/a.ts", symbol: "greet" },
			{ action: "enclosing", path: "src/a.ts", line: 12 },
			{ action: "symbols", query: "greet user" },
		];
		const bodies = [
			"src/a.ts:12:3  greet(user)",
			"Preview: 1 edit(s) in 1 file(s). Set apply=true to write.\n--- src/a.ts\n+++ src/a.ts\n-12: greet(user)\n+12: welcome(user)",
			"src/a.ts\n  1: function_declaration  greet\n  8: class_declaration  Widget",
			"src/a.ts:1  greet\nfunction greet(user: string) {\n  return user;\n}\n",
			"src/a.ts:1  greet\nfunction greet(user: string) {\n  return user;\n}",
			"src/a.ts  (3)\nsrc/b.ts  (1)",
		];
		for (const [index, args] of calls.entries()) {
			expect(rows(tool.renderCall?.(args, theme as never, ctx(args)))).toMatchSnapshot(
				`${args.action} call`,
			);
			expect(
				rows(
					tool.renderResult?.(
						{ content: [{ type: "text", text: bodies[index]! }], details: { outcome: "success" } },
						{ isPartial: false, expanded: false },
						theme as never,
						ctx(args),
					),
				),
			).toMatchSnapshot(`${args.action} body`);
		}
		const apply = { ...calls[1]!, apply: true };
		expect(rows(tool.renderCall?.(apply, theme as never, ctx(apply)))).toMatchSnapshot(
			"replace apply",
		);
		const search = calls[0]!;
		for (const [name, details, isError, isPartial, text] of [
			["empty", { outcome: "empty" }, false, false, "No matches in 2 file(s)."],
			["context error", { outcome: "success" }, true, false, "Cannot read src/a.ts."],
			["detail error", { outcome: "error" }, false, false, "ast-grep engine unavailable"],
			["partial", { outcome: "success" }, false, true, "src/a.ts:12:3  greet(user)"],
			["no details", undefined, false, false, "No matches."],
		] as const) {
			expect(
				rows(
					tool.renderResult?.(
						{ content: [{ type: "text", text }], details },
						{ expanded: false, isPartial },
						theme as never,
						ctx(search, { isError }),
					),
				),
			).toMatchSnapshot(name);
		}
	} finally {
		await fixture.restore();
	}
});
