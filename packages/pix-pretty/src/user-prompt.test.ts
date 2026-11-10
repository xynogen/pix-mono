import { expect, test } from "bun:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { withUserPrompt } from "./user-prompt.ts";

test("overlapping prompts each hold one lease and release on completion or failure", async () => {
	const events = createEventBus();
	const states: { state: string; blocks: number; message?: string }[] = [];
	events.on("pix:agent-state", (value) => states.push(value as (typeof states)[number]));
	let finish!: (value: string) => void;
	const first = withUserPrompt(
		{ kind: "question", message: "Choose" },
		(options) => {
			expect(options).toMatchObject({
				overlay: true,
				blocked: { kind: "question", message: "Choose" },
			});
			return new Promise<string>((resolve) => {
				finish = resolve;
			});
		},
		{ events, source: "ask" },
	);
	expect(states.at(-1)).toMatchObject({ state: "blocked", blocks: 1, message: "Choose" });
	await expect(
		withUserPrompt(
			{ kind: "auth", message: "Password" },
			async () => {
				throw new Error("UI failed");
			},
			{ events, source: "ssh" },
		),
	).rejects.toThrow("UI failed");
	expect(states.map((s) => s.blocks)).toEqual([1, 2, 1]);
	finish("answer");
	expect(await first).toBe("answer");
	expect(states.at(-1)).toMatchObject({ state: "idle", blocks: 0 });
	await expect(
		withUserPrompt(
			{ kind: "permission", message: "Approve" },
			() => {
				throw new Error("Open failed");
			},
			{ events, source: "gate" },
		),
	).rejects.toThrow("Open failed");
	expect(states.at(-1)).toMatchObject({ state: "idle", blocks: 0 });
});
