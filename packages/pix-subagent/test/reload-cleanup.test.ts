import { afterEach, describe, expect, test } from "bun:test";
import registerPixSubagent from "../src/index.ts";

const CLEANUP_KEY = "__pix-subagentCleanup";
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;

afterEach(() => {
	const cleanup = (globalThis as Record<string, unknown>)[CLEANUP_KEY];
	if (typeof cleanup === "function") (cleanup as () => void)();
	delete (globalThis as Record<string, unknown>)[CLEANUP_KEY];
	globalThis.setInterval = originalSetInterval;
	globalThis.clearInterval = originalClearInterval;
});

function host() {
	return {
		registerTool() {},
		registerMessageRenderer() {},
		on() {},
		getAvailableAgentTypes() {
			return [];
		},
		getAvailableModels() {
			return [];
		},
	} as never;
}

describe("pix-subagent reload cleanup", () => {
	test("disposes the manager cleanup interval", () => {
		const timer = { unref() {} } as ReturnType<typeof setInterval>;
		let cleared: ReturnType<typeof setInterval> | undefined;
		globalThis.setInterval = (() => timer) as unknown as typeof setInterval;
		globalThis.clearInterval = ((value: ReturnType<typeof setInterval>) => {
			cleared = value;
		}) as unknown as typeof clearInterval;

		registerPixSubagent(host());
		const cleanup = (globalThis as Record<string, unknown>)[CLEANUP_KEY];
		if (typeof cleanup !== "function") throw new Error("reload cleanup not registered");
		(cleanup as () => void)();

		expect(cleared).toBe(timer);
	});
});
