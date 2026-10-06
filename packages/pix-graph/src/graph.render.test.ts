import { expect, test } from "bun:test";
import { capturePi, makeRenderCtx } from "@xynogen/pix-pretty/test-utils";
import { collapseSection } from "@xynogen/pix-runtime/sections";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";
import registerGraph from "./graph.ts";

test("captures actual graph calls, progress, trees and terminal result states", async () => {
	const fixture = await withUiFixture();
	const globals = globalThis as { __pixOnce?: WeakMap<object, Set<string>> };
	const previousOnce = globals.__pixOnce;
	try {
		globals.__pixOnce = new WeakMap();
		const { pi, tool } = capturePi();
		registerGraph(pi as never);
		expect(tool.renderShell).toBe("self");
		const theme = roleTheme();
		const captures: Record<string, string[]> = {};
		const rows = (component: { render(width: number): string[] } | undefined, width = 80) => {
			if (!component) throw new Error("Missing graph renderer");
			return captureRows(component, { width, surface: "host-self" });
		};
		for (const [name, args] of Object.entries({
			build: { action: "build", path: "src" },
			bfs: { action: "query", question: "What calls authenticate?" },
			dfs: {
				action: "query",
				dfs: true,
				question:
					"Trace authenticate to the token cache and show each dependency across the request path.",
			},
		}))
			captures[name] = rows(tool.renderCall?.(args, theme, makeRenderCtx()));
		captures.hiddenCall = rows(
			tool.renderCall?.({ action: "build" }, theme, makeRenderCtx({ state: { collapsed: true } })),
		);
		const result = async (
			name: string,
			text: string,
			details: unknown,
			{ collapsed = false, expanded = false, isPartial = false, isError = false, width = 80 } = {},
		) => {
			await fixture.runtime.update(collapseSection, (current) => ({
				...current,
				enabled: collapsed,
				tools: {},
			}));
			const state = { collapsed };
			captures[name] = rows(
				tool.renderResult?.(
					{ content: [{ type: "text", text }], details },
					{ expanded, isPartial },
					theme,
					makeRenderCtx({ state, expanded, isError }),
				),
				width,
			);
			expect(state).toEqual({ collapsed });
		};
		const build = { _type: "graphResult", action: "build", outcome: "success" };
		const failure = { ...build, outcome: "error" };
		const text =
			"Graph built in 2s: 3 files → 8 nodes, 7 links, 2 communities → .pi/graph/ (view: /graph) · parsed 3 · reused 0";
		await result("built", text, build);
		await result("error", "Build failed: Operation aborted", failure);
		await result("partial", "Extracting 3 files…", build, { isPartial: true });
		await result("fallback", "one\n\ntwo", undefined);
		await result("running", "Extracting", {
			...build,
			outcome: "running",
			spinnerFrame: 2,
			elapsedMs: 2000,
			progress: { phase: "extract", fraction: 0.5, label: "Extracting 3 files" },
		});
		await result("runningFallback", "", { ...build, outcome: "running" });
		const query = {
			_type: "graphResult",
			action: "query",
			outcome: "success",
			query: {
				question: "authenticate",
				traversal: "bfs",
				hits: [
					{ label: "authenticate", where: "src/auth.ts", depth: 0 },
					{ label: "loadToken", via: "calls", where: "src/token.ts", depth: 1 },
					{ label: "cache", via: "reads", depth: 2 },
					{ label: "request", via: "called by", depth: 1 },
				],
			},
		};
		await result("tree", "raw query content", query);
		await result("empty", "No matching nodes in the graph.", {
			...query,
			query: { ...query.query, traversal: "dfs", hits: [] },
		});
		await result("collapsed", text, build, { collapsed: true });
		await result("collapsedError", "Build failed", failure, { collapsed: true, isError: true });
		await result("expanded", text, build, { collapsed: true, expanded: true });
		await result("wide", text, build, { width: 120 });
		expect(captures.fallback?.at(-1)).toBe(`<success>${"- ".repeat(40)}</success>`);
		expect(captures.built?.at(-1)).toBe(`<success>${"- ".repeat(40)}</success>`);
		expect(captures.error?.at(-1)).toBe(`<error>${"- ".repeat(40)}</error>`);
		expect(captures).toMatchSnapshot();
	} finally {
		if (previousOnce === undefined) delete globals.__pixOnce;
		else globals.__pixOnce = previousOnce;
		await fixture.restore();
	}
});
