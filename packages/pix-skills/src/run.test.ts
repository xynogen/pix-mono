import { describe, expect, it } from "bun:test";
import { runArgv } from "./run.ts";

// Use the running JS runtime as the child: `echo`, `head` and `ls` are not programs
// in a PowerShell session on Windows. process.execPath exists on every OS.
const js = (code: string) => [process.execPath, "-e", code];

describe("runArgv", () => {
	it("captures stdout", async () => {
		expect((await runArgv(js("console.log('hello')"), { cwd: process.cwd() })).trim()).toBe(
			"hello",
		);
	});

	it("caps output at maxBytes", async () => {
		const out = await runArgv(js("process.stdout.write('x'.repeat(100000))"), {
			cwd: process.cwd(),
			maxBytes: 1000,
		});
		expect(out.length).toBeGreaterThanOrEqual(1000);
		expect(out.length).toBeLessThanOrEqual(1100);
	});

	it("returns text on failure without throwing", async () => {
		const out = await runArgv(js("console.error('boom'); process.exit(3)"), {
			cwd: process.cwd(),
		});
		expect(out).toContain("boom");
	});

	it("returns text when the program does not exist", async () => {
		const out = await runArgv(["pix-no-such-program-xyz"], { cwd: process.cwd() });
		expect(out).toMatch(/command failed|not found|ENOENT/i);
	});

	it("handles empty argv", async () => {
		expect(await runArgv([], { cwd: process.cwd() })).toBe("(empty command)");
	});
});

it("cancels a directive process instead of waiting for its timeout", async () => {
	const controller = new AbortController();
	const pending = runArgv(js("setInterval(() => {}, 1000)"), {
		cwd: process.cwd(),
		signal: controller.signal,
	});
	controller.abort(new Error("user stopped skill"));
	await expect(pending).rejects.toThrow("user stopped skill");
});
