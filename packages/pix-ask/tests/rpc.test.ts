import { expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import {
	createEventBus,
	type ExtensionUIContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import registerAsk from "../src/index.ts";
import { rpcFallback } from "../src/rpc.ts";
import { SENTINEL_FREEFORM } from "../src/schema.ts";

const question = {
	question: "Which approach?",
	header: "Approach",
	options: [
		{ label: "REST", description: "REST API" },
		{ label: "GraphQL", description: "Graph API" },
	],
};
type UI = Pick<ExtensionUIContext, "select" | "input">;

for (const kind of ["select", "multi", "freeform"] as const) {
	test(`${kind} forwards cancellation to a pending host dialog and keeps prior answers`, async () => {
		const controller = new AbortController();
		let complete!: (value: string | undefined) => void;
		let opened!: () => void;
		const ready = new Promise<void>((resolve) => {
			opened = resolve;
		});
		let selects = 0;
		let inputs = 0;
		const pendingDialog = (signal?: AbortSignal) => {
			expect(signal).toBe(controller.signal);
			return new Promise<string | undefined>((resolve) => {
				const cancel = () => {
					signal?.removeEventListener("abort", cancel);
					resolve(undefined);
				};
				signal?.addEventListener("abort", cancel, { once: true });
				complete = resolve;
				opened();
			});
		};
		const ui: UI = {
			select: async (_title, options, opts) => {
				selects++;
				if (selects === 1) return options[0];
				return kind === "freeform" ? SENTINEL_FREEFORM : pendingDialog(opts?.signal);
			},
			input: async (_title, _placeholder, opts) => {
				inputs++;
				return pendingDialog(opts?.signal);
			},
		};
		let tool!: ToolDefinition;
		registerAsk({
			events: createEventBus(),
			registerTool: (value: ToolDefinition) => {
				tool = value;
			},
		} as never);
		const pending = tool.execute(
			"rpc",
			{ questions: [question, { ...question, multiSelect: kind === "multi" }, question] },
			controller.signal,
			undefined,
			{ hasUI: false, ui } as never,
		);
		await ready;
		controller.abort();
		const result = await pending;
		expect(result.details).toMatchObject({ answers: [{ answer: "REST" }], cancelled: true });
		expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("REST") }]);
		expect({ selects, inputs }).toEqual({
			selects: kind === "multi" ? 1 : 2,
			inputs: kind === "select" ? 0 : 1,
		});
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
		complete("late answer");
		await Promise.resolve();
		expect(result.details).toMatchObject({ answers: [{ answer: "REST" }], cancelled: true });
	});

	test(`${kind} rejects a late answer if cancellation wins before the continuation`, async () => {
		const controller = new AbortController();
		let selects = 0;
		let inputs = 0;
		const reply = () => {
			controller.abort();
			return kind === "multi" ? "1" : "REST";
		};
		const ui: UI = {
			select: async () => {
				selects++;
				return kind === "freeform" ? SENTINEL_FREEFORM : reply();
			},
			input: async () => {
				inputs++;
				return reply();
			},
		};
		const result = await rpcFallback(
			ui,
			{ questions: [{ ...question, multiSelect: kind === "multi" }, question] },
			controller.signal,
		);
		expect(result).toEqual({ answers: [], cancelled: true });
		expect({ selects, inputs }).toEqual({
			selects: kind === "multi" ? 0 : 1,
			inputs: kind === "select" ? 0 : 1,
		});
	});
}

test("pre-aborted RPC does not open a dialog", async () => {
	let calls = 0;
	const dialog = async () => {
		calls++;
		return "REST";
	};
	expect(
		await rpcFallback(
			{ select: dialog, input: dialog },
			{ questions: [question] },
			AbortSignal.abort(),
		),
	).toEqual({ answers: [], cancelled: true });
	expect(calls).toBe(0);
});

test("host errors stay errors instead of becoming cancellation", async () => {
	const error = new Error("RPC disconnected");
	await expect(
		rpcFallback(
			{
				select: async () => {
					throw error;
				},
				input: async () => undefined,
			},
			{ questions: [question] },
			new AbortController().signal,
		),
	).rejects.toBe(error);
});
