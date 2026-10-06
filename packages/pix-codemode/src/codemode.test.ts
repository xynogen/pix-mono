import { expect, test } from "bun:test";
import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { capturePi, makeRenderCtx } from "@xynogen/pix-pretty/test-utils";
import { collapseSection } from "@xynogen/pix-runtime/sections";
import { roleTheme, semanticRow, withUiFixture } from "../../../scripts/ui-capture.ts";
import { compactRenderers, compactRow, renderCall, renderResult } from "./codemode.ts";
import extension from "./extension.ts";

test("compact rows share child formatting and preserve native expanded components", () => {
	const theme = roleTheme();
	const nativeCall = { render: () => ["native call"], invalidate() {} };
	const nativeResult = { render: () => ["native details"], invalidate() {} };
	const seen: unknown[] = [];
	const native = {
		renderCall: (_args: unknown, _theme: unknown, ctx: any) => {
			seen.push(ctx.lastComponent);
			return nativeCall;
		},
		renderResult: (_result: unknown, _options: unknown, _theme: unknown, ctx: any) => {
			seen.push(ctx.lastComponent);
			return nativeResult;
		},
	};
	const renderer = compactRenderers("read", native, () => 12);
	const args = { path: "file.ts" };
	const result = { content: [{ type: "text" as const, text: "full output" }], details: {} };
	const ctx = { ...makeRenderCtx(), args, toolCallId: "read/1", isPartial: false };
	for (const isError of [false, true]) {
		const context = { ...ctx, isError };
		const rows = renderer.renderResult!(
			result,
			{ expanded: false, isPartial: false },
			theme as never,
			context as never,
		)
			.render(80)
			.map(semanticRow)
			.join("\n")
			.trimEnd();
		expect(rows).toBe(
			semanticRow(
				compactRow(
					{
						name: "read",
						args: JSON.stringify(args),
						status: isError ? "error" : "ok",
						durationMs: 12,
					},
					theme,
				),
			),
		);
		expect(renderer.renderCall!(args, theme as never, context as never).render(80)).toEqual([]);
	}
	const expanded = { ...ctx, expanded: true };
	for (let i = 0; i < 2; i++) {
		expect(renderer.renderCall!(args, theme as never, expanded as never)).toBe(nativeCall);
		expect(
			renderer.renderResult!(
				result,
				{ expanded: true, isPartial: false },
				theme as never,
				expanded as never,
			),
		).toBe(nativeResult);
	}
	expect(seen).toEqual([undefined, undefined, nativeCall, nativeResult]);
	const longArgs = "x".repeat(120);
	expect(compactRow({ name: "read", args: longArgs, status: "ok" }, theme)).toContain(
		`${"x".repeat(77)}...`,
	);
	expect(compactRow({ name: "read", args: longArgs, status: "ok" }, theme, true)).toContain(
		longArgs,
	);
});

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
	for (const name of ["bash", "read", "tool_search", "graph"]) {
		expect(resolver(name, () => other)).toBe(other);
		expect(resolver(name, () => undefined)).toBeUndefined();
	}
});

test("nested results follow their call IDs, not completion or script output order", async () => {
	const fixture = await withUiFixture();
	try {
		await fixture.runtime.update(collapseSection, { enabled: false });
		const captured = capturePi();
		const handlers = new Map<string, (event: any) => any>();
		Object.assign(captured.pi, {
			on: (name: string, handler: (event: any) => any) => handlers.set(name, handler),
			registerToolRenderer() {},
		});
		extension(captured.pi as unknown as ExtensionAPI);
		handlers.get("tool_execution_start")?.({ toolName: "codemode", toolCallId: "parent" });
		for (const [id, text] of [
			["parent/2", "graph result"],
			["parent/1", "bash result"],
		]) {
			handlers.get("tool_execution_end")?.({
				parentToolCallId: "parent",
				toolCallId: id,
				result: { content: [{ type: "text", text }] },
				isError: false,
			});
		}
		const calls = [
			{ id: "parent/1", name: "bash", args: "{}", status: "ok" },
			{ id: "parent/2", name: "graph", args: "{}", status: "ok" },
		];
		const partialResult = { content: [], details: { calls } };
		handlers.get("tool_execution_update")?.({
			toolName: "codemode",
			toolCallId: "parent",
			partialResult,
		});
		const live = renderResult(
			partialResult as never,
			{ expanded: true, isPartial: true },
			roleTheme(),
			makeRenderCtx(),
		).render!(120)
			.map(semanticRow)
			.join("\n");
		expect(live.indexOf("bash result")).toBeGreaterThan(live.indexOf("bash</toolTitle>"));
		expect(live.indexOf("bash result")).toBeLessThan(live.indexOf("graph</toolTitle>"));
		const event = {
			toolName: "codemode",
			toolCallId: "parent",
			details: { calls },
			content: [{ type: "text", text: "custom summary" }],
			isError: false,
		};
		const update = handlers.get("tool_result")?.(event);
		expect(update?.details.calls.map((call: any) => call.result.content[0].text)).toEqual([
			"bash result",
			"graph result",
		]);
		const rows = renderResult(
			{ content: event.content as never, details: update.details },
			{ expanded: true, isPartial: false },
			roleTheme(),
			makeRenderCtx(),
		).render!(120)
			.map(semanticRow)
			.join("\n");
		expect(event.content).toEqual([{ type: "text", text: "custom summary" }]);
		const duplicate = renderResult(
			{
				content: [{ type: "text", text: "bash result" }],
				details: update.details,
			},
			{ expanded: true, isPartial: false },
			roleTheme(),
			makeRenderCtx(),
		).render!(120)
			.map(semanticRow)
			.join("\n");
		expect(duplicate.match(/bash result/g)).toHaveLength(1);
		const command = {
			output: "command output",
			truncated: false,
			exit_code: 0,
			wall_time_seconds: 1,
		};
		const commandRows = renderResult(
			{
				content: [{ type: "text", text: JSON.stringify(command) }],
				details: {
					calls: [
						{
							...calls[0],
							result: {
								content: [{ type: "text", text: "different model-facing text" }],
								structuredContent: command,
							},
						},
					],
				} as never,
			},
			{ expanded: true, isPartial: false },
			roleTheme(),
			makeRenderCtx(),
		).render!(120)
			.map(semanticRow)
			.join("\n");
		expect(commandRows.match(/command output/g)).toHaveLength(1);
		expect(commandRows).toContain("exit 0");
		const segments = [
			"bash</toolTitle>",
			"bash result",
			"graph</toolTitle>",
			"graph result",
			"Script output",
			"custom summary",
		];
		let previous = -1;
		for (const segment of segments) {
			const index = rows.indexOf(segment);
			expect(index).toBeGreaterThan(previous);
			previous = index;
		}
		handlers.get("tool_execution_end")?.({ toolName: "codemode", toolCallId: "parent" });
		expect(handlers.get("tool_result")?.(event)).toBeUndefined();
	} finally {
		await fixture.restore();
	}
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

test("tool_search uses a compact row and restores full details on expansion", async () => {
	const fixture = await withUiFixture({ hostTheme: true });
	try {
		const captured = capturePi();
		let resolver!: (name: string, next: () => unknown) => unknown;
		Object.assign(captured.pi, {
			registerToolRenderer: (handler: typeof resolver) => {
				resolver = handler;
			},
		});
		extension(captured.pi as unknown as ExtensionAPI);
		const native = compactRenderers("tool_search", undefined, () => undefined);
		const renderer = resolver("tool_search", () => native) as typeof native;
		expect(renderer).toBe(native);
		const { ToolExecutionComponent } = await import("@earendil-works/pi-coding-agent");
		for (const isError of [false, true]) {
			const card = new ToolExecutionComponent(
				"tool_search",
				"lifecycle",
				{ query: "skills" },
				{},
				renderer,
				{ requestRender() {} } as never,
				fixture.agentDir,
			);
			card.markExecutionStarted();
			const rows = () => card.render(120).map(semanticRow);
			expect(rows()[1]).toStartWith("<warning>");
			const result = {
				content: [{ type: "text", text: "Loaded a tool.\nFull description" }],
				details: { loaded: ["read_skills"] },
				isError,
			};
			card.updateResult(result, true);
			expect(rows()).toHaveLength(2);
			card.updateResult(result, false);
			expect(rows()).toHaveLength(2);
			expect(rows()[1]).toStartWith(`<${isError ? "error" : "success"}>`);
			card.setExpanded(true);
			expect(rows().join("\n")).toContain("Full description");
			expect(rows().at(-1)).toBe(
				`<${isError ? "error" : "success"}>${"- ".repeat(60)}</${isError ? "error" : "success"}>`,
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
