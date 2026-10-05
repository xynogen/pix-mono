import { expect, it } from "bun:test";
import { Text } from "@earendil-works/pi-tui";
import { capturePi, makeRenderCtx, makeToolContext } from "@xynogen/pix-pretty/test-utils";
import type { ToolResultLike } from "@xynogen/pix-pretty/types";
import { collapseSection } from "@xynogen/pix-runtime/sections";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";

it("captures registered find scopes, highlights, batch and result states", async () => {
	const fixture = await withUiFixture();
	const color = process.env.FORCE_COLOR;
	try {
		const { registerFindTool } = await import("./find");
		const { viewportTextConstructor } = await import("@xynogen/pix-pretty/utils");
		const { pi, tool } = capturePi();
		registerFindTool(
			pi,
			() => ({
				execute: async () => {
					throw new Error("Capture must not execute find");
				},
			}),
			makeToolContext({ cwd: fixture.agentDir, TextComponent: viewportTextConstructor(Text) }),
		);
		expect(tool.renderShell).toBe("self");
		const theme = roleTheme();
		const rows = (component: { render(width: number): string[] } | undefined, width = 80) => {
			if (!component) throw new Error("Missing find renderer");
			return captureRows(component, { width, surface: "host-self" });
		};
		const matches = (text: string, extra = {}): ToolResultLike => ({
			content: [{ type: "text", text }],
			details: {
				_type: "findResult",
				text,
				pattern: "*.ts",
				path: "src",
				matchCount: text.split("\n").length,
				...extra,
			},
		});
		const render = async (
			result: ToolResultLike,
			{ width = 80, collapsed = false, expanded = false, isError = false, isPartial = false } = {},
		) => {
			fixture.setWidth(width);
			await fixture.runtime.update(collapseSection, (current) => ({
				...current,
				enabled: collapsed,
				tools: {},
			}));
			const state = { collapsed };
			const output = rows(
				tool.renderResult?.(
					result,
					{ isPartial },
					theme,
					makeRenderCtx({ state, expanded, isError }),
				),
				width,
			);
			expect(state).toEqual({ collapsed });
			return output;
		};
		const captures: Record<string, string[]> = {};
		captures.call = rows(
			tool.renderCall?.({ pattern: "*.ts", path: "src" }, theme, makeRenderCtx()),
		);
		captures.batchCall = rows(
			tool.renderCall?.({ patterns: ["*.ts", "*.txt", "*.json", "*.css"] }, theme, makeRenderCtx()),
		);
		captures.hiddenCall = rows(
			tool.renderCall?.({ pattern: "*.ts" }, theme, makeRenderCtx({ state: { collapsed: true } })),
		);
		captures.single = await render(matches("src/alpha.ts"));
		const result = matches("src/alpha.ts\nsrc/BETA.TS\n\n[200 limit reached]");
		captures.matches = await render(result);
		captures.partial = await render(result, { isPartial: true });
		captures.batch = await render(
			matches("===== *.ts =====\nsrc/alpha.ts\n\n===== *.txt =====\nnotes.txt", {
				patterns: ["*.ts", "*.txt"],
			}),
		);
		captures.collapsed = await render(result, { collapsed: true });
		captures.expanded = await render(result, { collapsed: true, expanded: true });
		const error = matches("Invalid glob pattern: [", { pattern: "[", matchCount: 0 });
		captures.error = await render(error, { isError: true });
		captures.collapsedError = await render(error, { collapsed: true, isError: true });
		captures.expandedError = await render(error, {
			collapsed: true,
			expanded: true,
			isError: true,
		});
		captures.empty = await render(matches("", { matchCount: 0 }));
		const long = matches(`src/${"detail-".repeat(18)}end.ts`);
		captures.long80 = await render(long);
		captures.long120 = await render(long, { width: 120 });
		expect(captures.single?.at(-1)).toBe(`<success>${"- ".repeat(40)}</success>`);
		expect(captures.error?.at(-1)).toBe(`<error>${"- ".repeat(40)}</error>`);
		expect(captures).toMatchSnapshot();
	} finally {
		if (color === undefined) delete process.env.FORCE_COLOR;
		else process.env.FORCE_COLOR = color;
		await fixture.restore();
	}
});
