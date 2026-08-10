import { afterEach, describe, expect, test } from "bun:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import registerGate from "./index.ts";

afterEach(() => {
	delete (globalThis as { __pixAgentState?: WeakMap<object, unknown> }).__pixAgentState;
});

describe("gate agent state", () => {
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
});
