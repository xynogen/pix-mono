import { expect, it } from "bun:test";
import { writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { capturePi, makeRenderCtx, makeToolContext } from "@xynogen/pix-pretty/test-utils";
import type { ToolResultLike } from "@xynogen/pix-pretty/types";
import { collapseSection, prettySection } from "@xynogen/pix-runtime/sections";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";

it("captures registered write/create completion and the configured diff split threshold", async () => {
	const fixture = await withUiFixture();
	const envNames = ["FORCE_COLOR", "DIFF_SPLIT_MIN_WIDTH", "DIFF_SPLIT_MIN_CODE_WIDTH"];
	const env = envNames.map((name) => [name, process.env[name]] as const);
	const pending: Promise<void>[] = [];
	const timers: ReturnType<typeof setTimeout>[] = [];
	const invalidators = new Map<string, () => void>();
	let restoreCache = () => {};
	try {
		// The module reads these two values at import. Keep the real 150-column threshold.
		process.env.DIFF_SPLIT_MIN_WIDTH = "150";
		process.env.DIFF_SPLIT_MIN_CODE_WIDTH = "60";
		await fixture.runtime.update(prettySection, {
			diff: { splitMinWidth: 150, splitMinCodeWidth: 60 },
		});
		const { registerWriteTool } = await import("./write");
		const { viewportTextConstructor } = await import("@xynogen/pix-pretty/utils");
		const { _cache } = await import("@xynogen/pix-pretty/highlight");
		const cache = new Map(_cache);
		restoreCache = () => {
			_cache.clear();
			for (const [key, value] of cache) _cache.set(key, value);
		};
		const { pi, tool } = capturePi();
		registerWriteTool(
			pi,
			() => ({
				execute: async () => {
					throw new Error("Capture must not execute write");
				},
			}),
			makeToolContext({
				cwd: fixture.agentDir,
				sp: basename,
				TextComponent: viewportTextConstructor(Text),
			}),
			(id, invalidate) => {
				invalidators.set(id, invalidate);
			},
		);
		expect(tool.renderShell).toBe("self");
		const theme = roleTheme();
		const rows = (component: { render(width: number): string[] } | undefined, width = 80) => {
			if (!component) throw new Error("Missing write renderer");
			return captureRows(component, { width, surface: "host-self" });
		};
		const captures: Record<string, string[]> = {};
		const existing = `${fixture.agentDir}/existing.ts`;
		const created = `${fixture.agentDir}/created.ts`;
		await writeFile(existing, "const count = 1;");
		captures.writeCall = rows(tool.renderCall?.({ path: existing }, theme, makeRenderCtx()));
		captures.hiddenCall = rows(
			tool.renderCall?.({ path: created }, theme, makeRenderCtx({ state: { collapsed: true } })),
		);
		const content = "const count = 3;\n// preserved trailing spaces  ";
		const fresh: ToolResultLike = {
			content: [{ type: "text", text: "written" }],
			details: { _type: "new", lines: 2, content, filePath: "created.ts" },
		};
		const callState: Record<string, unknown> = {};
		const resultState: Record<string, unknown> = {};
		const diffState: Record<string, unknown> = {};
		const finish = async (
			name: string,
			render: (
				context: ReturnType<typeof makeRenderCtx>,
			) => ReturnType<NonNullable<typeof tool.renderResult>>,
			state: Record<string, unknown>,
			expanded = false,
			width = 80,
		) => {
			fixture.setWidth(width);
			let invalidate!: () => void;
			const completed = new Promise<void>((resolve, reject) => {
				invalidate = resolve;
				timers.push(
					setTimeout(() => reject(new Error("Preview did not invalidate within 2000 ms")), 2000),
				);
			});
			pending.push(completed);
			const context = makeRenderCtx({ state, expanded, invalidate, toolCallId: name });
			const component = render(context);
			captures[`${name}Pending`] = rows(component, width);
			await completed;
			captures[name] = rows(render({ ...context, lastComponent: component }), width);
		};
		await finish(
			"create",
			(ctx) => {
				const component = tool.renderCall?.({ path: created, content }, theme, ctx);
				if (!component) throw new Error("Missing write call renderer");
				return component;
			},
			callState,
		);
		const callKey = callState._previewKey;
		await finish(
			"createExpanded",
			(ctx) => {
				const component = tool.renderCall?.({ path: created, content }, theme, ctx);
				if (!component) throw new Error("Missing write call renderer");
				return component;
			},
			callState,
			true,
		);
		expect(callState._previewKey).not.toBe(callKey);
		const resultRender = (result: ToolResultLike) => (ctx: ReturnType<typeof makeRenderCtx>) => {
			const component = tool.renderResult?.(result, { isPartial: false }, theme, ctx);
			if (!component) throw new Error("Missing write result renderer");
			return component;
		};
		await finish("new", resultRender(fresh), resultState);
		const resultKey = resultState._nfk;
		await finish("newExpanded", resultRender(fresh), resultState, true);
		expect(resultState._nfk).not.toBe(resultKey);
		expect(captures.new?.join("\n")).toContain("<syntaxKeyword>const</syntaxKeyword>");
		const diff: ToolResultLike = {
			content: [{ type: "text", text: "written" }],
			details: {
				_type: "diff",
				filePath: "existing.ts",
				summary: "+1 -1",
				oldContent: "const count = 1;",
				newContent: "const count = 3;",
				language: "typescript",
			},
		};
		await finish("unified", resultRender(diff), diffState);
		await finish("belowSplit", resultRender(diff), diffState, false, 149);
		await finish("split", resultRender(diff), diffState, false, 150);
		expect(invalidators.size).toBe(3);
		expect(captures.split?.join("\n")).toContain("┊");
		const render = async (
			result: ToolResultLike,
			{ collapsed = false, expanded = false, isError = false, isPartial = false } = {},
		) => {
			fixture.setWidth(80);
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
		captures.noChange = await render({
			content: [],
			details: { _type: "noChange", filePath: "existing.ts" },
		});
		captures.collapsed = await render(fresh, { collapsed: true });
		const error = { ...fresh, content: [{ type: "text" as const, text: "EACCES: created.ts" }] };
		captures.error = await render(error, { isError: true });
		captures.collapsedError = await render(error, { collapsed: true, isError: true });
		captures.expandedError = await render(error, {
			collapsed: true,
			expanded: true,
			isError: true,
		});
		captures.partialError = await render(error, { isError: true, isPartial: true });
		expect(captures.new?.at(-1)).toBe(`<success>${"- ".repeat(40)}</success>`);
		expect(captures.error?.at(-1)).toBe(`<error>${"- ".repeat(40)}</error>`);
		expect(captures).toMatchSnapshot();
	} finally {
		try {
			await Promise.all(pending);
		} finally {
			invalidators.clear();
			for (const timer of timers) clearTimeout(timer);
			restoreCache();
			for (const [name, value] of env) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			await fixture.restore();
		}
	}
});
