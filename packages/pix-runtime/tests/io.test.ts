import { expect, test } from "bun:test";
import { ioTimeoutMs, ioTimeoutSignal } from "../src/io.ts";

test("ioTimeoutMs converts the configured seconds to a positive millisecond value", () => {
	expect(ioTimeoutMs()).toBeGreaterThan(0);
	expect(ioTimeoutMs() % 1000).toBe(0);
});

test("ioTimeoutSignal follows the caller's abort and keeps its reason", () => {
	const caller = new AbortController();
	const signal = ioTimeoutSignal(caller.signal, 60_000);
	expect(signal.aborted).toBe(false);
	caller.abort("stop");
	expect(signal.aborted).toBe(true);
	expect(signal.reason).toBe("stop");
});

test("ioTimeoutSignal aborts with a TimeoutError after the deadline", async () => {
	const signal = ioTimeoutSignal(undefined, 10);
	await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
	expect((signal.reason as Error).name).toBe("TimeoutError");
});
