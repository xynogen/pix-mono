import { expect, test } from "bun:test";
import {
	runToolExecution,
	type ToolExecutionContext,
	toolFailureResult,
} from "../src/tool-execution.ts";

test("pre-cancelled execution never starts or publishes updates", async () => {
	let started = false;
	const updates: string[] = [];
	const result = await runToolExecution({
		signal: AbortSignal.abort(new Error("stop")),
		onUpdate: (value: string) => updates.push(value),
		execute: async () => {
			started = true;
			return "success";
		},
		onError: (_error, cancelled) => (cancelled ? "cancelled" : "error"),
	});
	expect({ result, started, updates }).toEqual({
		result: "cancelled",
		started: false,
		updates: [],
	});
});

test.each([
	false,
	true,
])("execution settles after cleanup and rejects late updates (cancel=%s)", async (cancel) => {
	const controller = new AbortController();
	const events: string[] = [];
	let scope!: ToolExecutionContext<string>;
	let complete!: (value: string) => void;
	const pending = runToolExecution({
		signal: controller.signal,
		onUpdate: (value: string) => events.push(value),
		execute: async (context) => {
			scope = context;
			context.onCleanup(() => events.push("cleanup"));
			context.update("awaiting-approval");
			context.update("running");
			return await new Promise<string>((resolve) => {
				complete = resolve;
			});
		},
		onError: (_error, cancelled) => {
			events.push(cancelled ? "cancelled" : "error");
			return "failed";
		},
	});
	if (cancel) controller.abort();
	scope.update("in flight");
	complete("success");
	expect(await pending).toBe(cancel ? "failed" : "success");
	scope.update("late success");
	scope.onCleanup(() => events.push("late cleanup"));
	expect(events).toEqual(
		cancel
			? ["awaiting-approval", "running", "cleanup", "cancelled", "late cleanup"]
			: ["awaiting-approval", "running", "in flight", "cleanup", "late cleanup"],
	);
});

test("all cleanup runs in reverse order and failures preserve the operation error", async () => {
	const events: string[] = [];
	const failure = new Error("command failed");
	const cleanupFailure = new Error("cleanup failed");
	const result = await runToolExecution({
		execute: async ({ onCleanup }) => {
			onCleanup(() => {
				events.push("first");
			});
			onCleanup(() => {
				events.push("second");
				throw cleanupFailure;
			});
			throw failure;
		},
		onError: (error, cancelled) => ({ error, cancelled }),
	});
	expect(events).toEqual(["second", "first"]);
	expect(result.cancelled).toBe(false);
	expect(result.error).toBeInstanceOf(AggregateError);
	expect((result.error as AggregateError).errors).toEqual([failure, cleanupFailure]);
});

test("cleanup failures remain errors even when cancellation is active", async () => {
	const controller = new AbortController();
	const result = await runToolExecution({
		signal: controller.signal,
		execute: async ({ onCleanup }) => {
			onCleanup(() => {
				throw new Error("cleanup did not finish");
			});
			controller.abort();
			return "late";
		},
		onError: (error, cancelled) => ({ error, cancelled }),
	});
	expect(result).toMatchObject({ cancelled: false, error: expect.any(AggregateError) });
});

test.each([
	[new Error("provider failed"), "provider failed"],
	["provider unavailable", "provider unavailable"],
	[undefined, "undefined"],
	[null, "null"],
])("standard failure preserves the error message (%s)", (error, text) => {
	expect(toolFailureResult(error, false, "https://example.test", "Fetch cancelled.")).toEqual({
		content: [{ type: "text", text }],
		details: { outcome: "error", target: "https://example.test", meta: "failed" },
		isError: true,
	});
});

test("standard cancellation uses tool wording without exposing the abort reason", () => {
	expect(
		toolFailureResult(new Error("private reason"), true, "test query", "Search cancelled."),
	).toEqual({
		content: [{ type: "text", text: "Search cancelled." }],
		details: { outcome: "cancelled", target: "test query", meta: "cancelled" },
	});
});
