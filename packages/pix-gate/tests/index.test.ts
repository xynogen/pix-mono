import { afterEach, describe, expect, test } from "bun:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { setUnattendedMode } from "@xynogen/pix-runtime";
import registerGate from "../src/index.ts";

afterEach(() => {
	delete (globalThis as { __pixAgentState?: WeakMap<object, unknown> }).__pixAgentState;
});

type Result = { block?: boolean; reason?: string } | undefined;

/** Register the gate with the given tools, run one tool call, and count dialogs. */
async function run(
	toolName: string,
	input: Record<string, unknown>,
	opts: { tools?: string[]; dialog?: "approved" | "denied"; nuclear?: boolean } = {},
): Promise<{ result: Result; dialogs: number }> {
	const handlers: Array<(event: any, ctx: any) => Promise<unknown>> = [];
	const pi = {
		events: createEventBus(),
		getAllTools: () => (opts.tools ?? []).map((name) => ({ name })),
		on(event: string, handler: (event: any, ctx: any) => Promise<unknown>) {
			if (event === "tool_call") handlers.push(handler);
		},
	};
	registerGate(pi as never);
	if (opts.nuclear) setUnattendedMode(pi.events, "nuclear");
	let dialogs = 0;
	const ctx = {
		hasUI: true,
		ui: {
			custom: async () => {
				dialogs++;
				return { action: opts.dialog ?? "denied" };
			},
			notify() {},
			theme: { fg: (_color: string, text: string) => text },
		},
	};
	let result: Result;
	for (const handler of handlers) {
		const r = (await handler({ toolName, input }, ctx)) as Result;
		if (r?.block) result = r;
	}
	return { result, dialogs };
}

describe("gate flow", () => {
	test("Python source is never classified as a shell command", async () => {
		expect(
			await run(
				"python_run",
				{ code: 'print("sudo rm -rf /; git push --force")' },
				{ tools: ["sudo_run"] },
			),
		).toEqual({ result: undefined, dialogs: 0 });
	});
	test("nuclear skips redirects, circuit breakers, and path approval without dialogs", async () => {
		for (const tool of [
			"bash",
			"powershell",
			"proc",
			"read",
			"write",
			"edit",
			"grep",
			"find",
			"ls",
		]) {
			for (const command of ["ssh host uptime", "sudo id", "rm -rf /", "git push --force"]) {
				expect(
					await run(
						tool,
						{ command, path: ".env", paths: ["~/.ssh"] },
						{ nuclear: true, tools: ["ssh_run", "sudo_run"] },
					),
				).toEqual({ result: undefined, dialogs: 0 });
			}
		}
	});
	test("plain ssh redirects to ssh_run even with no matching rule", async () => {
		const { result } = await run("bash", { command: "ssh host uptime" }, { tools: ["ssh_run"] });
		expect(result?.reason).toContain("ssh_run");
	});

	test("plain ssh passes when ssh_run is not installed", async () => {
		const { result, dialogs } = await run("bash", { command: "ssh host uptime" });
		expect([result, dialogs]).toEqual([undefined, 0]);
	});

	test(".env reads redirect to read_env without a dialog when it is installed", async () => {
		for (const [tool, input] of [
			["read", { paths: ["a.ts", ".env"] }],
			["bash", { command: "cat .env" }],
		] as const) {
			const { result, dialogs } = await run(tool, input, { tools: ["read_env"] });
			expect([result?.block, dialogs]).toEqual([true, 0]);
			expect(result?.reason).toContain("read_env");
		}
	});

	test(".env reads keep the approval dialog without read_env", async () => {
		const { result, dialogs } = await run("read", { path: ".env" });
		expect([result?.block, dialogs]).toEqual([true, 1]);
		expect(result?.reason).not.toContain("read_env");
	});

	test("quoted sudo is not redirected", async () => {
		const { result, dialogs } = await run(
			"bash",
			{ command: 'git commit -m "remove sudo from docs"' },
			{ tools: ["sudo_run"] },
		);
		expect([result, dialogs]).toEqual([undefined, 0]);
	});
});

describe("file tool path gate", () => {
	test("read with a batch `paths` entry hits the .env block", async () => {
		const { result, dialogs } = await run("read", { paths: ["src/a.ts", ".env"] });
		expect([result?.block, dialogs]).toEqual([true, 1]);
	});

	test("ls on ~/.ssh asks", async () => {
		const { dialogs } = await run("ls", { path: "~/.ssh" });
		expect(dialogs).toBe(1);
	});

	test("grep in src passes", async () => {
		const { result, dialogs } = await run("grep", { pattern: "x", path: "src" });
		expect([result, dialogs]).toEqual([undefined, 0]);
	});
});

describe("gate agent state", () => {
	test("auto-approved shell and file tools never report blocked", async () => {
		const events = createEventBus();
		const states: string[] = [];
		events.on("pix:agent-state", (raw) => states.push((raw as { state: string }).state));
		const handlers: Array<(event: any, ctx: any) => Promise<unknown>> = [];
		registerGate({
			events,
			on(event: string, handler: (event: any, ctx: any) => Promise<unknown>) {
				if (event === "tool_call") handlers.push(handler);
			},
		} as never);
		setUnattendedMode(events, "yolo");
		let dialogs = 0;
		const ctx = {
			hasUI: true,
			ui: {
				custom: async () => {
					dialogs++;
					return { action: "denied" };
				},
				notify() {},
				theme: { fg: (_color: string, text: string) => text },
			},
		};
		for (const toolName of [
			"bash",
			"powershell",
			"proc",
			"read",
			"write",
			"edit",
			"grep",
			"find",
			"ls",
		]) {
			for (const handler of handlers) {
				expect(
					await handler({ toolName, input: { command: "git push --force", path: ".env" } }, ctx),
				).toBeUndefined();
			}
		}
		expect({ states, dialogs }).toEqual({ states: [], dialogs: 0 });
	});

	test("reports blocked while waiting for command approval", async () => {
		const events = createEventBus();
		const states: string[] = [];
		events.on("pix:agent-state", (event) => states.push((event as { state: string }).state));
		const handlers: Array<(event: any, ctx: any) => Promise<unknown>> = [];
		const pi = {
			events,
			on(event: string, handler: (event: any, ctx: any) => Promise<unknown>) {
				if (event === "tool_call") handlers.push(handler);
			},
		};
		registerGate(pi as never);

		const ctx = {
			hasUI: true,
			ui: {
				custom: async () => ({ action: "denied" }),
				notify() {},
				theme: { fg: (_color: string, text: string) => text },
			},
		};
		for (const handler of handlers) {
			await handler({ toolName: "bash", input: { command: "git push --force" } }, ctx);
		}

		expect(states).toContain("blocked");
		expect(states.at(-1)).toBe("idle");
	});

	test("steers a denied ~/.ssh/config read toward the ssh info tool", async () => {
		const events = createEventBus();
		const handlers: Array<(event: any, ctx: any) => Promise<unknown>> = [];
		const pi = {
			events,
			getAllTools: () => [{ name: "ssh_run" }],
			on(event: string, handler: (event: any, ctx: any) => Promise<unknown>) {
				if (event === "tool_call") handlers.push(handler);
			},
		};
		registerGate(pi as never);

		const ctx = {
			hasUI: true,
			ui: {
				custom: async () => ({ action: "denied" }),
				notify() {},
				theme: { fg: (_color: string, text: string) => text },
			},
		};
		let result: { block?: boolean; reason?: string } | undefined;
		for (const handler of handlers) {
			const r = (await handler(
				{ toolName: "bash", input: { command: "grep -i p1-server ~/.ssh/config" } },
				ctx,
			)) as { block?: boolean; reason?: string } | undefined;
			if (r?.block) result = r;
		}

		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("ssh_run");
		expect(result?.reason).toContain('action:"info"');
	});

	test("omits the ssh steer when ssh_run is not installed", async () => {
		const events = createEventBus();
		const handlers: Array<(event: any, ctx: any) => Promise<unknown>> = [];
		const pi = {
			events,
			getAllTools: () => [],
			on(event: string, handler: (event: any, ctx: any) => Promise<unknown>) {
				if (event === "tool_call") handlers.push(handler);
			},
		};
		registerGate(pi as never);

		const ctx = {
			hasUI: true,
			ui: {
				custom: async () => ({ action: "denied" }),
				notify() {},
				theme: { fg: (_color: string, text: string) => text },
			},
		};
		let result: { block?: boolean; reason?: string } | undefined;
		for (const handler of handlers) {
			const r = (await handler(
				{ toolName: "bash", input: { command: "grep -i p1-server ~/.ssh/config" } },
				ctx,
			)) as { block?: boolean; reason?: string } | undefined;
			if (r?.block) result = r;
		}

		expect(result?.block).toBe(true);
		expect(result?.reason).not.toContain("ssh_run");
	});
});
