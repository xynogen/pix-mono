import { afterEach, describe, expect, test } from "bun:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
	beginAgentActivity,
	beginAgentBlock,
	bindAgentStateEvents,
	type PixAgentStateEvent,
	withAgentBlock,
} from "./herdr-state.ts";

afterEach(() => {
	delete (globalThis as { __pixAgentState?: WeakMap<object, unknown> }).__pixAgentState;
});

function observe() {
	const events = createEventBus();
	const states: PixAgentStateEvent[] = [];
	events.on("pix:agent-state", (event) => states.push(event as PixAgentStateEvent));
	const unbind = bindAgentStateEvents(events);
	return { events, states, unbind };
}

describe("agent state coordinator", () => {
	test("reports nested activity as working until every activity ends", () => {
		const { events, states, unbind } = observe();
		const endFirst = beginAgentActivity(events, "subagent", "Agent one");
		const endSecond = beginAgentActivity(events, "subagent", "Agent two");

		expect(states.at(-1)).toMatchObject({ state: "working", activities: 2, blocks: 0 });
		endFirst();
		expect(states.at(-1)).toMatchObject({ state: "working", activities: 1, blocks: 0 });
		endSecond();
		expect(states.at(-1)).toEqual({ state: "idle", activities: 0, blocks: 0 });
		unbind();
	});

	test("blocked takes priority and restores working activity afterward", () => {
		const { events, states, unbind } = observe();
		const endActivity = beginAgentActivity(events, "subagent", "Agent running");
		const endBlock = beginAgentBlock(events, "ask_user", "Waiting for user answer");

		expect(states.at(-1)).toMatchObject({
			state: "blocked",
			message: "Waiting for user answer",
			activities: 1,
			blocks: 1,
		});
		endBlock();
		expect(states.at(-1)).toMatchObject({ state: "working", activities: 1, blocks: 0 });
		endActivity();
		unbind();
	});

	test("release is idempotent and state can be requested after subscription", () => {
		const { events, states, unbind } = observe();
		const end = beginAgentBlock(events, "gate", "Approval required");
		end();
		end();
		events.emit("pix:agent-state:request", undefined);

		expect(states.at(-1)).toEqual({ state: "idle", activities: 0, blocks: 0 });
		unbind();
	});

	test("withAgentBlock releases blocked state when prompt throws", async () => {
		const { events, states, unbind } = observe();
		await expect(
			withAgentBlock(events, "sudo", "Root approval required", async () => {
				throw new Error("overlay failed");
			}),
		).rejects.toThrow("overlay failed");
		expect(states.at(-1)).toEqual({ state: "idle", activities: 0, blocks: 0 });
		unbind();
	});
});
