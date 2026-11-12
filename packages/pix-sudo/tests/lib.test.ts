import { expect, mock, test } from "bun:test";
import * as exec from "@xynogen/pix-runtime/exec";

// Capture what would be spawned; no real sudo runs.
const calls: { args: readonly string[]; input: unknown }[] = [];
mock.module("@xynogen/pix-runtime/exec", () => ({
	...exec,
	runTool: async (_name: string, args: readonly string[], opts: { input?: unknown }) => {
		calls.push({ args, input: opts.input });
		return { stdout: "", stderr: "", code: 0 };
	},
}));

const { runWithSudo } = await import("../src/lib.ts");

// Regression: the command used to rely on the ticket `sudo -v` left behind.
// Tickets are per-tty/ppid, so a fresh sudo got an empty password and failed.
test("runWithSudo with a password ignores cached tickets and sends the password", async () => {
	calls.length = 0;
	await runWithSudo("id", "secret");
	expect(calls).toEqual([{ args: ["-k", "-S", "--", "sh", "-c", "id"], input: "secret\n" }]);
});

test("runWithSudo without a password relies on the cached ticket", async () => {
	calls.length = 0;
	await runWithSudo("id", "");
	expect(calls).toEqual([{ args: ["-S", "--", "sh", "-c", "id"], input: "\n" }]);
});
