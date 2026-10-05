import { expect, test } from "bun:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { makeRenderCtx } from "@xynogen/pix-pretty/test-utils";
import { collapseSection } from "@xynogen/pix-runtime/sections";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";
import type { DiagnosticSnapshot } from "./types.ts";

test("captures registered diagnostics tools and the subscribed widget without a server", async () => {
	const fixture = await withUiFixture();
	const tools: ToolDefinition[] = [];
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	let widget: unknown;
	let snapshots: DiagnosticSnapshot[] = [];
	const output: string[] = [];
	const theme = roleTheme();
	const ctx = {
		ui: {
			setStatus() {},
			setWidget: (_key: string, content: unknown) => {
				widget = content;
			},
		},
	};
	try {
		const { default: register } = await import("./diagnostics.ts");
		register(
			{
				registerTool: (tool: ToolDefinition) => tools.push(tool),
				on: (event: string, fn: (event: unknown, ctx: unknown) => unknown) =>
					handlers.set(event, fn),
			} as never,
			{
				cwd: fixture.agentDir,
				manager: {
					check: async () => snapshots,
					navigate: async () => {
						throw new Error("Capture must not navigate");
					},
					activeServerIds: () => [],
					shutdown: async () => {},
				},
			},
		);
		expect(tools.map((tool) => [tool.name, tool.renderShell])).toEqual([
			["lens_diagnostics", "self"],
			["lsp_navigation", "self"],
			["lens_diagnostic_mark", "self"],
		]);
		const rows = (
			label: string,
			component: { render(width: number): string[] } | undefined,
			width = 80,
			surface: "host-self" | "component" = "host-self",
		) => {
			if (!component) throw new Error("Missing diagnostics renderer");
			fixture.setWidth(width);
			const rendered = captureRows(component, { width, surface });
			output.push(label, ...rendered);
			return rendered;
		};
		const cases = [
			{
				args: { source: "lsp", paths: ["src/a.ts"] },
				text: "src/a.ts:3:4 error ts(2304) Missing name",
				details: { files: 1, findings: 1, unconfirmed: 0, unavailable: 0 },
			},
			{
				args: { operation: "references", path: "src/a.ts" },
				text: "src/a.ts:3:4\nsrc/b.ts:9:2",
				details: { operation: "references", results: 2 },
			},
			{
				args: { action: "set", disposition: "defer" },
				text: "Marked src/a.ts TS2304 as defer.",
				details: { count: 1 },
			},
		];
		for (const [index, tool] of tools.entries()) {
			const item = cases[index]!;
			const result = {
				content: [{ type: "text" as const, text: item.text }],
				details: { outcome: "success", ...item.details },
			};
			await fixture.runtime.update(collapseSection, (current) => ({
				...current,
				enabled: false,
				tools: {},
			}));
			rows(
				`${tool.name}:call`,
				tool.renderCall?.(item.args, theme as never, makeRenderCtx() as never),
			);
			for (const state of [
				"success",
				"partial",
				"error",
				"no-details",
				"no-details-error",
			] as const) {
				const isError = state.endsWith("error");
				const rendered = rows(
					`${tool.name}:${state}`,
					tool.renderResult?.(
						{ ...result, details: state.startsWith("no-details") ? undefined : result.details },
						{ isPartial: state === "partial", expanded: false },
						theme as never,
						makeRenderCtx({ isError }) as never,
					),
				);
				if (state === "success" || state === "error")
					expect(rendered.at(-1)).toBe(
						`<${isError ? "error" : "success"}>${"- ".repeat(40)}</${isError ? "error" : "success"}>`,
					);
				else expect(rendered).toHaveLength(item.text.split("\n").length + 1);
			}
			await fixture.runtime.update(collapseSection, (current) => ({
				...current,
				enabled: true,
				tools: {},
			}));
			for (const expanded of [false, true]) {
				const context = makeRenderCtx({ state: { collapsed: true }, expanded });
				rows(
					`${tool.name}:${expanded ? "expanded" : "hidden-call"}`,
					tool.renderCall?.(item.args, theme as never, context as never),
				);
				rows(
					`${tool.name}:${expanded ? "expanded-result" : "collapsed"}`,
					tool.renderResult?.(
						result,
						{ isPartial: false, expanded },
						theme as never,
						context as never,
					),
				);
				expect(context.state as unknown).toEqual({ collapsed: true });
			}
		}
		await handlers.get("session_start")!({}, ctx);
		snapshots = [
			{
				filePath: `${fixture.agentDir}/src/touched.ts`,
				checkedAt: 1,
				diagnostics: [],
				state: "touched",
			},
		];
		await handlers.get("tool_result")!(
			{
				toolName: "write",
				input: { path: "src/touched.ts" },
				content: [{ type: "text", text: "Written." }],
			},
			ctx,
		);
		expect(widget).toBeUndefined();
		output.push("widget:touched-only (no registered row)");
		const diag = tools[0]!;
		const showWidget = async (label: string, width = 80) => {
			await diag.execute(
				"capture",
				{ source: "lsp", paths: ["src/a.ts"] },
				undefined,
				undefined,
				{} as never,
			);
			if (typeof widget !== "function") throw new Error("Missing subscribed widget");
			rows(label, widget({}, theme), width, "component");
		};
		snapshots = [
			{
				filePath: `${fixture.agentDir}/src/clean.ts`,
				checkedAt: 1,
				diagnostics: [],
				state: "clean",
			},
		];
		await showWidget("widget:clean");
		snapshots = ["a", "b", "c", "d"].map((name, index) => ({
			filePath: `${fixture.agentDir}/src/${name}.ts`,
			checkedAt: index + 2,
			state: "findings",
			diagnostics: [
				{
					filePath: `${fixture.agentDir}/src/${name}.ts`,
					line: 3,
					column: 4,
					severity: index === 0 ? "warning" : "error",
					message: "Missing name",
				},
			],
		}));
		snapshots.push(
			{
				filePath: `${fixture.agentDir}/src/unknown.ts`,
				checkedAt: 7,
				diagnostics: [],
				state: "unconfirmed",
			},
			{
				filePath: `${fixture.agentDir}/src/offline.ts`,
				checkedAt: 8,
				diagnostics: [],
				state: "unavailable",
			},
		);
		await showWidget("widget:mixed-overflow", 120);
		await showWidget("widget:narrow", 24);
		expect(output.join("\n")).toMatchSnapshot();
	} finally {
		try {
			await handlers.get("session_shutdown")?.({}, ctx);
		} finally {
			await fixture.restore();
		}
	}
	expect(widget).toBeUndefined();
});
