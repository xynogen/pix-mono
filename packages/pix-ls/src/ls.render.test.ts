import { expect, it } from "bun:test";
import { Text } from "@earendil-works/pi-tui";
import { capturePi, makeRenderCtx, makeToolContext } from "@xynogen/pix-pretty/test-utils";
import type { ToolResultLike } from "@xynogen/pix-pretty/types";
import { collapseSection, prettySection } from "@xynogen/pix-runtime/sections";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";

it("captures registered ls calls, grid, tree, batch and result states", async () => {
	const fixture = await withUiFixture();
	const color = process.env.FORCE_COLOR;
	try {
		const { registerLsTool } = await import("./ls");
		const { viewportTextConstructor } = await import("@xynogen/pix-pretty/utils");
		const { pi, tool } = capturePi();
		registerLsTool(
			pi,
			() => ({
				execute: async () => {
					throw new Error("Capture must not execute ls");
				},
			}),
			makeToolContext({ cwd: fixture.agentDir, TextComponent: viewportTextConstructor(Text) }),
		);
		expect(tool.renderShell).toBe("self");
		const theme = roleTheme();
		const rows = (component: { render(width: number): string[] } | undefined) => {
			if (!component) throw new Error("Missing ls renderer");
			return captureRows(component, { width: 80, surface: "host-self" });
		};
		const listing = (text: string, extra = {}): ToolResultLike => ({
			content: [{ type: "text", text }],
			details: {
				_type: "lsResult",
				text,
				path: "src",
				entryCount: text.split("\n").length,
				...extra,
			},
		});
		const render = async (
			result: ToolResultLike,
			{ collapsed = false, expanded = false, isError = false, isPartial = false } = {},
		) => {
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
			);
			expect(state).toEqual({ collapsed });
			return output;
		};
		const captures: Record<string, string[]> = {};
		captures.call = rows(tool.renderCall?.({ path: "src" }, theme, makeRenderCtx()));
		captures.batchCall = rows(
			tool.renderCall?.({ paths: ["src", "lib", "test", "docs"] }, theme, makeRenderCtx()),
		);
		captures.hiddenCall = rows(
			tool.renderCall?.({ path: "src" }, theme, makeRenderCtx({ state: { collapsed: true } })),
		);
		await fixture.runtime.update(prettySection, { lsStyle: "grid" });
		captures.single = await render(listing("alpha.txt"));
		const result = listing(".env\nfolder/\nalpha.txt\nname with spaces.txt");
		captures.grid = await render(result);
		await fixture.runtime.update(prettySection, { lsStyle: "tree" });
		captures.tree = await render(result);
		captures.partial = await render(result, { isPartial: true });
		captures.batch = await render(
			listing("===== src =====\nalpha.txt\n\n===== lib =====\nbeta.txt", { paths: ["src", "lib"] }),
		);
		captures.collapsed = await render(result, { collapsed: true });
		captures.expanded = await render(result, { collapsed: true, expanded: true });
		const error = listing("ENOENT: cannot list src");
		captures.error = await render(error, { isError: true });
		captures.collapsedError = await render(error, { collapsed: true, isError: true });
		captures.expandedError = await render(error, {
			collapsed: true,
			expanded: true,
			isError: true,
		});
		captures.fallback = await render({
			content: [{ type: "text", text: "listed" }],
			details: undefined,
		});
		expect(captures.single?.at(-1)).toBe(`<success>${"- ".repeat(40)}</success>`);
		expect(captures.error?.at(-1)).toBe(`<error>${"- ".repeat(40)}</error>`);
		expect(captures).toMatchSnapshot();
	} finally {
		if (color === undefined) delete process.env.FORCE_COLOR;
		else process.env.FORCE_COLOR = color;
		await fixture.restore();
	}
});
