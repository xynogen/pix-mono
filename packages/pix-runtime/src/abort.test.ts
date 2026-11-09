import { expect, test } from "bun:test";
import { abortable, cancellationCheckpoint, onAbort } from "./abort.ts";

test("onAbort handles existing cancellation and detaches completed work", () => {
	const cancelled = AbortSignal.abort();
	let calls = 0;
	onAbort(cancelled, () => calls++);
	const controller = new AbortController();
	const detach = onAbort(controller.signal, () => calls++);
	detach();
	controller.abort();
	expect(calls).toBe(1);
});

test("abortable rejects promptly, observes late failures, and preserves the reason", async () => {
	for (const alreadyAborted of [true, false]) {
		const controller = new AbortController();
		const reason = new Error("cancelled by user");
		if (alreadyAborted) controller.abort(reason);
		let fail!: (reason: Error) => void;
		const pending = abortable(
			new Promise<never>((_, reject) => {
				fail = reject;
			}),
			controller.signal,
		);
		controller.abort(reason);
		await expect(pending).rejects.toBe(reason);
		fail(new Error("late provider failure"));
	}
});

test("checkpoint yields so queued cancellation is processed", async () => {
	const controller = new AbortController();
	setImmediate(() => controller.abort());
	await expect(cancellationCheckpoint(controller.signal)).rejects.toThrow();
});
