import { describe, expect, test } from "bun:test";
import registerLoopNudge, { createLoopTracker, LOOP_THRESHOLD, loopReason } from "./loop.ts";

const out = (text: string) => [{ type: "text", text }];

describe("createLoopTracker", () => {
	test("fires once on the threshold-th identical call, then stays quiet for that streak", () => {
		const track = createLoopTracker(3);
		const hits = [1, 2, 3, 4, 5].map(() => track("bash", { command: "ls" }, out("a")));
		expect(hits).toEqual([undefined, undefined, ["bash"], undefined, undefined]);
	});

	test("a changed result or argument resets the streak", () => {
		const track = createLoopTracker(3);
		track("bash", { command: "test" }, out("fail"));
		track("bash", { command: "test" }, out("fail"));
		expect(track("bash", { command: "test" }, out("pass"))).toBeUndefined();
		track("read", { path: "a" }, out("x"));
		track("read", { path: "a" }, out("x"));
		expect(track("read", { path: "b" }, out("x"))).toBeUndefined();
	});

	test("detects an alternating cycle on its third full repetition", () => {
		const track = createLoopTracker(3);
		const step = (i: number) =>
			i % 2
				? track("bash", { command: "make" }, out("err"))
				: track("edit", { path: "a" }, out("ok"));
		const hits = [0, 1, 2, 3, 4, 5, 6].map(step);
		expect(hits).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			["edit", "bash"],
			undefined,
		]);
	});

	test("breaking the pattern re-arms the warning", () => {
		const track = createLoopTracker(3);
		for (let i = 0; i < 3; i++) track("grep", { p: "x" }, out("none"));
		track("read", { path: "a" }, out("x"));
		const hits = [0, 1, 2].map(() => track("grep", { p: "x" }, out("none")));
		expect(hits).toEqual([undefined, undefined, ["grep"]]);
	});

	test("a failing call loops on the same error even when the arguments change", () => {
		const track = createLoopTracker(3);
		const err = (detail: string) => out(`Edit without read\n${detail}`);
		const hits = ["a", "b", "c"].map((p) => track("edit", { path: p }, err(p), true));
		expect(hits).toEqual([undefined, undefined, ["edit"]]);
	});

	test("successful calls with changed arguments are not a loop", () => {
		const track = createLoopTracker(3);
		const hits = ["a", "b", "c"].map((p) => track("read", { path: p }, out("x"), false));
		expect(hits).toEqual([undefined, undefined, undefined]);
	});
});

describe("loopReason", () => {
	test("names a single tool or the whole cycle", () => {
		expect(loopReason(["grep"], 3)).toMatch(/^Same `grep` call returned the same result 3 times/);
		expect(loopReason(["edit", "bash"], 3)).toMatch(
			/^Same 2-call cycle \(`edit` → `bash`\) returned/,
		);
		expect(loopReason(["edit"], 3, true)).toMatch(
			/^Same `edit` call failed with the same error 3 times/,
		);
	});
});

describe("registerLoopNudge", () => {
	test("appends a labelled line to the looping result and notifies", async () => {
		let handler: ((event: unknown, ctx: unknown) => unknown) | undefined;
		const notes: string[] = [];
		registerLoopNudge({
			on: (_e: string, fn: typeof handler) => {
				handler = fn;
			},
		} as never);
		const ctx = { ui: { notify: (m: string) => notes.push(m) } };
		const event = { toolName: "grep", input: { pattern: "x" }, content: out("none") };
		let result: unknown;
		for (let i = 0; i < LOOP_THRESHOLD; i++) result = await handler?.(event, ctx);

		expect(result).toEqual({
			content: [...out("none"), { type: "text", text: `[pix-nudge] ${loopReason(["grep"], 3)}` }],
			structuredContent: undefined,
		});
		expect(notes).toEqual([loopReason(["grep"], 3)]);
	});
});
