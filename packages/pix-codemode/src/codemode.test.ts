import { expect, test } from "bun:test";
import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { capturePi, makeRenderCtx } from "@xynogen/pix-pretty/test-utils";
import { collapseSection } from "@xynogen/pix-runtime/sections";
import { roleTheme, semanticRow, withUiFixture } from "../../../scripts/ui-capture.ts";
import { renderCall, renderResult } from "./codemode.ts";
import extension from "./extension.ts";

test("uses the renderer hook without replacing native tool execution", () => {
	const captured = capturePi();
	let resolver!: (name: string, next: () => unknown) => unknown;
	Object.assign(captured.pi, {
		registerToolRenderer: (handler: typeof resolver) => {
			resolver = handler;
		},
	});
	extension(captured.pi as unknown as ExtensionAPI);
	expect(typeof resolver).toBe("function");
	expect(captured.names).toEqual([]);
	expect(resolver("codemode", () => undefined)).toEqual({
		renderCall,
		renderResult,
		renderShell: "self",
	});
	const other = { renderCall: () => "native" };
	expect(resolver("read", () => other)).toBe(other);
});

test("extension wraps the enabled native tool only after session start", () => {
	const captured = capturePi();
	let start: (() => void) | undefined;
	Object.assign(captured.pi, {
		on: (event: string, handler: () => void) => {
			if (event === "session_start") start = handler;
		},
		getAllTools: () => [{ name: "codemode" }],
	});
	const native = capturePi();
	createCodemodeExtension()(native.pi as unknown as ExtensionAPI);
	extension(captured.pi as unknown as ExtensionAPI);
	expect(captured.names).toEqual([]);
	expect(typeof start).toBe("function");
	start?.();
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
});

test("tool_search collapses and restores the full result through the renderer hook", async () => {
	const fixture = await withUiFixture({ hostTheme: true });
	try {
		await fixture.runtime.update(collapseSection, (current) => ({ ...current, enabled: true }));
		const captured = capturePi();
		let resolver!: (name: string, next: () => unknown) => unknown;
		Object.assign(captured.pi, {
			registerToolRenderer: (handler: typeof resolver) => {
				resolver = handler;
			},
		});
		extension(captured.pi as unknown as ExtensionAPI);
		const renderer = resolver("tool_search", () => undefined) as {
			renderShell: string;
			renderCall: NonNullable<
				import("@earendil-works/pi-coding-agent").ToolDefinition["renderCall"]
			>;
			renderResult: NonNullable<
				import("@earendil-works/pi-coding-agent").ToolDefinition["renderResult"]
			>;
		};
		expect(renderer.renderShell).toBe("self");
		expect(captured.names).toEqual([]);
		const { ToolExecutionComponent } = await import(
			new URL(
				"./modes/interactive/components/tool-execution.js",
				import.meta.resolve("@earendil-works/pi-coding-agent"),
			).href
		);
		await fixture.runtime.update(collapseSection, (current) => ({
			...current,
			enabled: true,
			delaySec: 0.001,
			tools: {},
		}));
		for (const isError of [false, true]) {
			let completed = Promise.withResolvers<void>();
			const card = new ToolExecutionComponent(
				"tool_search",
				"lifecycle",
				{ query: "skills" },
				{},
				renderer,
				{ requestRender: () => completed.resolve() },
				fixture.agentDir,
			);
			const rows = () => card.render(120).map(semanticRow);
			expect(rows()[1]).toStartWith("<muted>");
			card.markExecutionStarted();
			expect(rows()[1]).toStartWith("<warning>");
			const result = {
				content: [{ type: "text", text: "Loaded a tool.\nFull description" }],
				details: { loaded: ["read_skills"] },
				isError,
			};
			card.updateResult(result, true);
			expect(rows().at(-1)).toContain("Full description");
			completed = Promise.withResolvers<void>();
			card.updateResult(result, false);
			const role = isError ? "error" : "success";
			expect(rows()[1]).toStartWith(`<${role}>`);
			expect(rows().at(-1)).toBe(`<${role}>${"- ".repeat(60)}</${role}>`);
			await completed.promise;
			expect(rows()).toHaveLength(2);
			expect(rows()[1]).toStartWith(`<${role}>`);
			card.setExpanded(true);
			expect(rows().join("\n")).toContain("Full description");
			expect(rows().at(-1)).toBe(`<${role}>${"- ".repeat(60)}</${role}>`);
		}
		await fixture.runtime.update(collapseSection, (current) => ({ ...current, delaySec: 10 }));
		const theme = roleTheme() as never;
		const state: { collapsed?: boolean; timer?: ReturnType<typeof setTimeout> } = {};
		for (const [executionStarted, isPartial, isError, role] of [
			[false, true, false, "muted"],
			[true, true, false, "warning"],
			[true, false, false, "success"],
			[true, false, true, "error"],
		] as const) {
			const call = renderer
				.renderCall(
					{ query: "skills" },
					theme,
					makeRenderCtx({ executionStarted, isPartial, isError, state }) as never,
				)
				.render(80)
				.map(semanticRow)
				.join("\n");
			expect(call).toStartWith(`<${role}>`);
		}
		const partial = {
			content: [{ type: "text" as const, text: "Searching" }],
			details: { loaded: [] },
		};
		renderer.renderResult(
			partial,
			{ expanded: false, isPartial: true },
			theme,
			makeRenderCtx({ state }) as never,
		);
		expect(state.timer).toBeUndefined();
		renderer.renderResult(
			partial,
			{ expanded: false, isPartial: false },
			theme,
			makeRenderCtx({ state }) as never,
		);
		expect(state.timer).toBeDefined();
		clearTimeout(state.timer);
		state.timer = undefined;
		state.collapsed = true;
		const ctx = makeRenderCtx({ isPartial: false, state }) as never;
		const result = {
			content: [{ type: "text" as const, text: "Loaded 1 tool.\n- read_skills: Full description" }],
			details: { loaded: ["read_skills"] },
		};
		const collapsed = renderer
			.renderResult(result, { expanded: false, isPartial: false }, theme, ctx)
			.render(80)
			.map(semanticRow)
			.join("\n");
		expect(collapsed).toContain(
			"<toolTitle+bold>tool_search</toolTitle+bold> <dim>read_skills</dim>",
		);
		expect(renderer.renderCall({ query: "skills" }, theme, ctx).render(80)).toEqual([]);
		for (const isError of [false, true]) {
			const expanded = renderer
				.renderResult(
					result,
					{ expanded: true, isPartial: false },
					theme,
					makeRenderCtx({ expanded: true, isError, state: { collapsed: true } }) as never,
				)
				.render(80)
				.map(semanticRow);
			expect(expanded.join("\n")).toContain("Full description");
			expect(expanded.at(-1)).toBe(
				`<${isError ? "error" : "success"}>${"- ".repeat(40)}</${isError ? "error" : "success"}>`,
			);
		}
	} finally {
		await fixture.restore();
	}
});

test("extension does not enable a disabled native codemode tool", () => {
	const captured = capturePi();
	let start: (() => void) | undefined;
	Object.assign(captured.pi, {
		on: (event: string, handler: () => void) => {
			if (event === "session_start") start = handler;
		},
		getAllTools: () => [],
	});
	extension(captured.pi as unknown as ExtensionAPI);
	start?.();
	expect(captured.names).toEqual([]);
});
