import { describe, expect, test } from "bun:test";
import { COLLAPSED_TOOL_GLYPH, padIcon } from "@xynogen/pix-pretty/utils";
import { createAgentInfoTool, createAgentResultTool, createAgentSteerTool } from "../src/tools.ts";

// Markers are width-normalized (padIcon) so wide and narrow glyphs share a column.
const OK = padIcon(COLLAPSED_TOOL_GLYPH.success);
const WARN = padIcon(COLLAPSED_TOOL_GLYPH.warning);
const ERR = padIcon(COLLAPSED_TOOL_GLYPH.error);
const STOP = padIcon("■");

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

const ctx = {
	modelRegistry: {
		getAvailable: () => [
			{ provider: "test", id: "one" },
			{ provider: "test", id: "two" },
			{ provider: "test", id: "three" },
			{ provider: "test", id: "four" },
			{ provider: "test", id: "five" },
		],
		getAll: () => [],
	},
	model: undefined,
};

async function execute(tool: unknown, params: Record<string, unknown>, context: unknown = {}) {
	return (tool as { execute: (...args: unknown[]) => Promise<unknown> }).execute(
		"call",
		params,
		new AbortController().signal,
		undefined,
		context,
	);
}

function render(tool: unknown, result: unknown, expanded = false): string {
	const component = (
		tool as {
			renderResult: (...args: unknown[]) => { render(width: number): string[] };
		}
	).renderResult(result, { expanded, isPartial: false }, theme, {
		state: { collapsed: true },
		expanded,
		invalidate: () => {},
	});
	return component
		.render(160)
		.map((line) => line.trimEnd())
		.join("\n")
		.trimEnd();
}

function renderCall(
	tool: unknown,
	args: Record<string, unknown>,
	collapsed: boolean,
	expanded = false,
): string {
	const component = (
		tool as {
			renderCall: (...args: unknown[]) => { render(width: number): string[] };
		}
	).renderCall(args, theme, {
		state: { collapsed },
		expanded,
		invalidate: () => {},
	});
	return component
		.render(160)
		.map((line) => line.trimEnd())
		.join("\n")
		.trimEnd();
}

describe("subagent utility compact renderers", () => {
	test("use the self-rendered shell so compact status marks have no box padding", () => {
		expect(createAgentInfoTool(() => {}).renderShell).toBe("self");
		expect(createAgentResultTool({} as never, new Map()).renderShell).toBe("self");
		expect(createAgentSteerTool({} as never).renderShell).toBe("self");
	});

	test("hide the separate call heading after collapse and restore it on expansion", () => {
		const cases: Array<[unknown, Record<string, unknown>]> = [
			[createAgentInfoTool(() => {}), { kind: "types" }],
			[createAgentResultTool({} as never, new Map()), { agent_id: "abc123" }],
			[createAgentSteerTool({} as never), { agent_id: "abc123", action: "steer" }],
		];
		for (const [tool, args] of cases) {
			expect(renderCall(tool, args, true)).toBe("");
			expect(renderCall(tool, args, true, true)).not.toBe("");
		}
	});

	test("agent_info summarizes the authoritative count and expands exact content", async () => {
		const tool = createAgentInfoTool(() => {});
		const result = await execute(tool, { kind: "models", limit: 5 }, ctx);
		expect(render(tool, result)).toContain(`${OK} agent_info models · 5 available`);
		const text = (result as { content: { text: string }[] }).content[0]?.text ?? "";
		expect(render(tool, result, true)).toContain(text);
	});

	test("agent_result covers completed, running, queued, error, and not-found", async () => {
		for (const [status, marker, label] of [
			["completed", OK, "completed"],
			["steered", OK, "steered"],
			["running", WARN, "still running"],
			["queued", WARN, "queued"],
			["aborted", WARN, "aborted"],
			["stopped", STOP, "stopped"],
			["error", ERR, "error"],
		] as const) {
			const record = {
				id: "abc123",
				status,
				result: status === "completed" ? "Exact final output" : undefined,
				error: status === "error" ? "provider failed" : undefined,
				resultConsumed: false,
			};
			const manager = { getRecord: () => record };
			const activity = new Map([["abc123", { responseText: "Partial output" }]]);
			const tool = createAgentResultTool(manager as never, activity as never);
			const result = await execute(tool, { agent_id: "abc123", verbose: false });
			const output = render(tool, result);
			expect(output).toContain(`${marker} agent_result abc123 · ${label}`);
			const exact = (result as { content: { text: string }[] }).content[0]?.text ?? "";
			expect(render(tool, result, true)).toContain(exact);
			expect(record.resultConsumed).toBe(true);
		}

		const tool = createAgentResultTool({ getRecord: () => undefined } as never, new Map());
		const result = await execute(tool, { agent_id: "missing", verbose: false });
		expect(render(tool, result)).toContain(`${ERR} agent_result missing · not found`);
	});

	test("agent_result preserves verbose conversation semantics", async () => {
		const record = {
			status: "completed",
			result: "latest",
			resultConsumed: false,
			session: {
				messages: [{ role: "assistant", content: [{ type: "text", text: "Full chat" }] }],
			},
		};
		const tool = createAgentResultTool({ getRecord: () => record } as never, new Map());
		const result = await execute(tool, { agent_id: "abc123", verbose: true });
		expect((result as { details: { verbose: boolean } }).details.verbose).toBe(true);
		expect(render(tool, result, true)).toContain(
			(result as { content: { text: string }[] }).content[0]?.text ?? "",
		);
	});

	test("agent steer and stop outcomes are metadata-driven", async () => {
		const steerRecord = { status: "running", session: { steer: async () => {} } };
		let tool = createAgentSteerTool({ getRecord: () => steerRecord } as never);
		let result = await execute(tool, { agent_id: "abc123", action: "steer", message: "focus" });
		expect(render(tool, result)).toContain(`${OK} agent_steer abc123 · delivered`);

		const queuedRecord: { status: string; pendingSteers?: string[] } = { status: "queued" };
		tool = createAgentSteerTool({ getRecord: () => queuedRecord } as never);
		result = await execute(tool, { agent_id: "abc123", action: "steer", message: "focus" });
		expect(render(tool, result)).toContain(`${WARN} agent_steer abc123 · queued`);

		const stoppedRecord = { status: "running", result: "partial" };
		tool = createAgentSteerTool({ getRecord: () => stoppedRecord, abort: () => true } as never);
		result = await execute(tool, { agent_id: "abc123", action: "stop" });
		expect(render(tool, result)).toContain(`${STOP} agent_stop abc123 · partial output saved`);
		expect(render(tool, result, true)).toContain(
			(result as { content: { text: string }[] }).content[0]?.text ?? "",
		);
	});

	test("agent steer covers not-found, invalid, already-finished, and execution errors", async () => {
		let tool = createAgentSteerTool({ getRecord: () => undefined } as never);
		let result = await execute(tool, { agent_id: "missing", action: "steer", message: "focus" });
		expect(render(tool, result)).toContain(`${ERR} agent_steer missing · not found`);

		tool = createAgentSteerTool({ getRecord: () => ({ status: "running" }) } as never);
		result = await execute(tool, { agent_id: "abc123", action: "steer" });
		expect(render(tool, result)).toContain(`${ERR} agent_steer abc123 · invalid`);

		tool = createAgentSteerTool({
			getRecord: () => ({ status: "completed", result: "done" }),
			abort: () => false,
		} as never);
		result = await execute(tool, { agent_id: "abc123", action: "stop" });
		expect(render(tool, result)).toContain(`${WARN} agent_stop abc123 · already finished`);

		tool = createAgentSteerTool({
			getRecord: () => ({
				status: "running",
				session: { steer: async () => Promise.reject(new Error("transport failed")) },
			}),
		} as never);
		result = await execute(tool, { agent_id: "abc123", action: "steer", message: "focus" });
		expect(render(tool, result)).toContain(`${ERR} agent_steer abc123 · error`);
	});
});
