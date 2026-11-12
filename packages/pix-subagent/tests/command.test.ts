import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { AgentManager } from "../src/agent-manager.ts";
import { describePrompt, parseAgentArgs } from "../src/command.ts";
import registerPixSubagent from "../src/index.ts";
import type { AgentRecord } from "../src/types.ts";
import { COMMAND_RESULT_TYPE, type CommandResultDetails } from "../src/ui/command-result.ts";

afterEach(() => mock.restore());

test("parseAgentArgs reads flags anywhere and keeps the prompt", () => {
	expect(parseAgentArgs("--type Explore find the auth code --ctx")).toEqual({
		prompt: "find the auth code",
		type: "Explore",
		ctx: true,
	});
	expect(parseAgentArgs("summarise --model openai/gpt-5 README")).toEqual({
		prompt: "summarise README",
		model: "openai/gpt-5",
		ctx: false,
	});
	expect(parseAgentArgs("--type")).toBe("--type needs a value.");
	expect(parseAgentArgs("--model --ctx x")).toBe("--model needs a value.");
	expect(parseAgentArgs("   ")).toEqual({ prompt: "", ctx: false });
	expect(describePrompt("one two three four five six")).toBe("one two three four five…");
});

test("/agent spawns a background agent whose result is a card, never a steer", async () => {
	spyOn(globalThis, "setInterval").mockImplementation((() => 1) as never);
	spyOn(globalThis, "clearInterval").mockImplementation(() => {});
	let manager: AgentManager | undefined;
	const spawned: Parameters<AgentManager["spawn"]>[] = [];
	spyOn(AgentManager.prototype, "spawn").mockImplementation(function (this: AgentManager, ...args) {
		manager = this;
		spawned.push(args);
		return "agent-probe";
	});
	const hooks = new Map<string, (event: unknown, ctx: unknown) => void>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const entries: { type: string; data: CommandResultDetails }[] = [];
	const sent: unknown[] = [];
	const notes: { text: string; level: string }[] = [];
	const pi = {
		registerTool() {},
		registerMessageRenderer() {},
		registerEntryRenderer() {},
		registerCommand: (
			name: string,
			options: { handler: (a: string, c: unknown) => Promise<void> },
		) => commands.set(name, options),
		on: (event: string, fn: (event: unknown, ctx: unknown) => void) => hooks.set(event, fn),
		sendMessage: (message: unknown) => sent.push(message),
		appendEntry: (type: string, data: CommandResultDetails) => entries.push({ type, data }),
	};
	const ctx = {
		mode: "tui",
		cwd: process.cwd(),
		model: { provider: "test", id: "model-one", name: "Model One" },
		modelRegistry: { getAll: () => [], find: () => undefined },
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: {
			setStatus() {},
			setWidget() {},
			notify: (text: string, level: string) => notes.push({ text, level }),
		},
	};
	registerPixSubagent(pi as never);
	hooks.get("session_start")!({}, ctx);
	const run = commands.get("agent")!.handler;
	try {
		await run("", ctx);
		expect(notes.at(-1)).toMatchObject({ level: "warning" });
		expect(notes.at(-1)?.text).toContain("Usage: /agent");

		await run("--type nope do it", ctx);
		expect(notes.at(-1)).toMatchObject({ level: "error" });
		expect(spawned).toHaveLength(0);

		await run("--model missing/model do it", ctx);
		expect(notes.at(-1)?.level).toBe("error");
		expect(spawned).toHaveLength(0);

		await run("--type explore --ctx map the repo layout", ctx);
		const [, , type, prompt, options] = spawned[0]!;
		expect(type).toBe("Explore");
		expect(prompt).toBe("map the repo layout");
		expect(options).toMatchObject({
			description: "map the repo layout",
			isBackground: true,
			inheritContext: true,
			invocation: { fromCommand: true, modelName: "model one" },
		});
		expect(options.signal).toBeUndefined();
		expect(notes.at(-1)).toEqual({
			text: "Agent agent-probe started — the main agent will keep running.",
			level: "info",
		});

		const record: AgentRecord = {
			id: "agent-probe",
			type: "Explore",
			description: "map the repo layout",
			status: "completed",
			invocation: options.invocation,
			result: "  src/ holds the code  ",
			toolUses: 3,
			turnCount: 2,
			startedAt: 1_000,
			completedAt: 4_000,
			streamingMs: 0,
			compactionCount: 0,
			lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
			isBackground: true,
		};
		(manager as unknown as { onComplete: (r: AgentRecord) => void }).onComplete(record);
		expect(sent).toHaveLength(0);
		expect(entries).toEqual([
			{
				type: COMMAND_RESULT_TYPE,
				data: {
					id: "agent-probe",
					type: "Explore",
					prompt: "map the repo layout",
					status: "completed",
					model: "model one",
					durationMs: 3_000,
					toolUses: 3,
					result: "src/ holds the code",
					error: undefined,
				},
			},
		]);
	} finally {
		hooks.get("session_shutdown")!({}, ctx);
	}
});
