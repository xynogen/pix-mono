import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { AgentManager } from "../src/agent-manager.ts";
import registerPixSubagent from "../src/index.ts";
import type { createAgentTool } from "../src/tools.ts";
import type { AgentRecord } from "../src/types.ts";

afterEach(() => mock.restore());

test("background completion wakes the parent only with opt-in and safe idle state", async () => {
	const timers = new Map<number, () => void>();
	let timerId = 0;
	spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
		timers.set(++timerId, callback);
		return timerId;
	}) as never);
	spyOn(globalThis, "clearTimeout").mockImplementation(((id: number) =>
		timers.delete(id)) as never);
	spyOn(globalThis, "setInterval").mockImplementation((() => ++timerId) as never);
	spyOn(globalThis, "clearInterval").mockImplementation(() => {});
	let manager: AgentManager | undefined;
	let invocation: AgentRecord["invocation"];
	const spawn = spyOn(AgentManager.prototype, "spawn").mockImplementation(function (
		this: AgentManager,
		...args
	) {
		manager = this;
		invocation = args[4].invocation;
		return "agent-probe";
	});
	const hooks = new Map<string, (event: any, ctx: any) => void>();
	const tools = new Map<string, ReturnType<typeof createAgentTool>>();
	const messages: {
		message: { content: string; display: boolean };
		options: { triggerTurn: boolean; deliverAs: string };
	}[] = [];
	const pi = {
		registerTool: (tool: ReturnType<typeof createAgentTool>) => tools.set(tool.name, tool),
		registerMessageRenderer() {},
		on: (event: string, fn: (event: any, ctx: any) => void) => hooks.set(event, fn),
		sendMessage: (message: any, options: any) => messages.push({ message, options }),
	};
	let idle = true;
	let pending = false;
	const ctx = {
		mode: "tui",
		cwd: process.cwd(),
		modelRegistry: { getAll: () => [] },
		isIdle: () => idle,
		hasPendingMessages: () => pending,
		ui: { setStatus() {}, setWidget() {} },
	};
	registerPixSubagent(pi as never);
	hooks.get("session_start")!({}, ctx);
	const tool = tools.get("agent")!;
	expect(tool.parameters.properties.remind).toMatchObject({ type: "boolean", default: false });
	expect(tool.parameters.required).not.toContain("remind");
	const execute = (extra: Record<string, unknown>) =>
		tool.execute(
			"call",
			{
				type: "Explore",
				prompt: "Read only",
				description: "Probe",
				...extra,
			} as never,
			undefined,
			undefined,
			ctx as never,
		);
	const complete = (status: AgentRecord["status"] = "completed", resultConsumed = false) => {
		const record: AgentRecord = {
			id: "agent-probe",
			type: "Explore",
			description: "Probe",
			status,
			invocation,
			result: "Useful finding",
			toolUses: 0,
			turnCount: 0,
			startedAt: 1,
			completedAt: 2,
			streamingMs: 0,
			compactionCount: 0,
			lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
			resultConsumed,
			isBackground: true,
		};
		(manager as unknown as { onComplete: (record: AgentRecord) => void }).onComplete(record);
		for (const [id, callback] of [...timers]) {
			timers.delete(id);
			callback();
		}
	};
	try {
		await execute({ remind: true });
		expect(invocation?.remind).toBe(true);
		complete();
		expect(messages.at(-1)?.message.content).toMatch(/Useful finding[\s\S]*Continue the main task/);
		expect(messages.at(-1)?.message.display).toBe(true);
		expect(messages.at(-1)?.options).toEqual({ triggerTurn: true, deliverAs: "steer" });
		await execute({});
		expect(invocation?.remind).toBe(false);
		complete();
		expect(messages.at(-1)?.options.triggerTurn).toBe(false);
		await execute({ remind: true });
		idle = false;
		complete();
		expect(messages.at(-1)?.options.triggerTurn).toBe(false);
		idle = true;
		pending = true;
		complete();
		expect(messages.at(-1)?.options.triggerTurn).toBe(false);
		pending = false;
		for (const mode of ["rpc", "json", "print"]) {
			ctx.mode = mode;
			complete();
			expect(messages.at(-1)?.options.triggerTurn).toBe(false);
		}
		ctx.mode = "tui";
		hooks.get("agent_settled")!({ aborted: true }, ctx);
		complete();
		expect(messages.at(-1)?.options.triggerTurn).toBe(false);
		hooks.get("before_agent_start")!({ messageType: "user" }, ctx);
		complete();
		expect(messages.at(-1)?.options.triggerTurn).toBe(true);
		hooks.get("agent_end")!({ messages: [{ role: "assistant", stopReason: "error" }] }, ctx);
		complete();
		expect(messages.at(-1)?.options.triggerTurn).toBe(false);
		hooks.get("before_agent_start")!({ messageType: "user" }, ctx);
		for (const status of ["aborted", "stopped", "error"] as const) {
			complete(status);
			expect(messages.at(-1)?.options.triggerTurn).toBe(false);
		}
		const count = messages.length;
		complete("completed", true);
		expect(messages).toHaveLength(count);
		const calls = spawn.mock.calls.length;
		const invalid = await execute({ remind: "true" });
		expect(invalid).toMatchObject({ isError: true });
		expect(spawn).toHaveBeenCalledTimes(calls);
	} finally {
		hooks.get("session_shutdown")!({}, ctx);
	}
});
