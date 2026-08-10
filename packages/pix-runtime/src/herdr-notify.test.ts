import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { bindHerdrNotify } from "./herdr-notify.ts";

// Minimal stand-in for the child_process.spawn return we touch (.on/.unref).
function fakeSpawn() {
	const calls: string[][] = [];
	const fn = ((_cmd: string, args: string[]) => {
		calls.push(args);
		return { on() {}, unref() {} };
	}) as unknown as typeof import("node:child_process").spawn;
	return { fn, calls };
}

const ENV = process.env.HERDR_ENV;
const MUTE = process.env.PIX_HERDR_NOTIFY;

beforeEach(() => {
	process.env.HERDR_ENV = "1";
	delete process.env.PIX_HERDR_NOTIFY;
});
afterEach(() => {
	if (ENV === undefined) delete process.env.HERDR_ENV;
	else process.env.HERDR_ENV = ENV;
	if (MUTE === undefined) delete process.env.PIX_HERDR_NOTIFY;
	else process.env.PIX_HERDR_NOTIFY = MUTE;
	delete (globalThis as { __pixAgentState?: unknown }).__pixAgentState;
});

describe("herdr notify bridge", () => {
	test("fires once on the transition into blocked, with the message + request sound", () => {
		const events = createEventBus();
		const spawn = fakeSpawn();
		bindHerdrNotify(events, spawn.fn);

		events.emit("pix:agent-state", { state: "working", activities: 1, blocks: 0 });
		events.emit("pix:agent-state", {
			state: "blocked",
			message: "Approve?",
			activities: 1,
			blocks: 1,
		});
		events.emit("pix:agent-state", {
			state: "blocked",
			message: "Approve?",
			activities: 1,
			blocks: 1,
		});

		expect(spawn.calls).toEqual([["notification", "show", "Approve?", "--sound", "request"]]);
	});

	test("re-fires after leaving and re-entering blocked", () => {
		const events = createEventBus();
		const spawn = fakeSpawn();
		bindHerdrNotify(events, spawn.fn);

		events.emit("pix:agent-state", { state: "blocked", activities: 0, blocks: 1 });
		events.emit("pix:agent-state", { state: "idle", activities: 0, blocks: 0 });
		events.emit("pix:agent-state", { state: "blocked", activities: 0, blocks: 1 });

		expect(spawn.calls).toHaveLength(2);
		expect(spawn.calls[0]?.[2]).toBe("Pi needs your attention"); // default message
	});

	test("no-op outside a herdr pane", () => {
		delete process.env.HERDR_ENV;
		const events = createEventBus();
		const spawn = fakeSpawn();
		bindHerdrNotify(events, spawn.fn);
		events.emit("pix:agent-state", { state: "blocked", activities: 0, blocks: 1 });
		expect(spawn.calls).toHaveLength(0);
	});

	test("muted by PIX_HERDR_NOTIFY=0", () => {
		process.env.PIX_HERDR_NOTIFY = "0";
		const events = createEventBus();
		const spawn = fakeSpawn();
		bindHerdrNotify(events, spawn.fn);
		events.emit("pix:agent-state", { state: "blocked", activities: 0, blocks: 1 });
		expect(spawn.calls).toHaveLength(0);
	});
});
