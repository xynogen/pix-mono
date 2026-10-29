import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import workingExtension from "./working.ts";

afterEach(() => mock.restore());

function setup(mode: ExtensionContext["mode"] = "tui") {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	const setWorkingMessage = mock((_message?: string) => {});
	const ctx = { mode, ui: { setWorkingMessage } } as unknown as ExtensionContext;
	let tick = () => {};
	const unref = mock(() => {});
	const interval = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
		tick = callback;
		return { unref };
	}) as unknown as typeof setInterval);
	const clear = spyOn(globalThis, "clearInterval").mockImplementation(() => {});
	const now = spyOn(performance, "now").mockReturnValue(1000);
	workingExtension({
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI);
	return {
		emit: (event: string) => handlers.get(event)?.({}, ctx),
		tick: () => tick(),
		setWorkingMessage,
		interval,
		clear,
		now,
		unref,
	};
}

test("working label counts the whole agent run and resets at the end", () => {
	const h = setup();
	h.emit("agent_start");
	expect(h.setWorkingMessage.mock.calls.at(-1)).toEqual(["Working (0s)"]);
	expect(h.interval.mock.calls[0]?.[1]).toBe(1000);
	expect(h.unref).toHaveBeenCalledTimes(1);
	for (const [elapsed, label] of [
		[12_999, "Working (12s)"],
		[65_000, "Working (1m 5s)"],
	] as const) {
		h.now.mockReturnValue(1000 + elapsed);
		h.tick();
		expect(h.setWorkingMessage.mock.calls.at(-1)).toEqual([label]);
	}
	h.emit("agent_end");
	expect(h.clear).toHaveBeenCalledTimes(1);
	expect(h.setWorkingMessage.mock.calls.at(-1)).toEqual([]);
	h.emit("session_shutdown");
	expect(h.clear).toHaveBeenCalledTimes(1);
});

test("restarting replaces the timer; shutdown cleans it up", () => {
	const h = setup();
	h.emit("agent_start");
	h.emit("agent_start");
	expect(h.interval).toHaveBeenCalledTimes(2);
	expect(h.clear).toHaveBeenCalledTimes(1);
	h.emit("session_shutdown");
	expect(h.clear).toHaveBeenCalledTimes(2);
	expect(h.setWorkingMessage.mock.calls.at(-1)).toEqual([]);
});

for (const mode of ["rpc", "json", "print"] as const) {
	test(`working timer stays inactive in ${mode} mode`, () => {
		const h = setup(mode);
		h.emit("agent_start");
		h.emit("agent_end");
		h.emit("session_shutdown");
		expect(h.interval).toHaveBeenCalledTimes(0);
		expect(h.setWorkingMessage).toHaveBeenCalledTimes(0);
	});
}
