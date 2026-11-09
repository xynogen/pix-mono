import { expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { createEventBus, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import registerAsk from "./index.ts";
import type { QuestionnaireResult } from "./types.ts";

const question = {
	question: "Which approach?",
	header: "Approach",
	options: [
		{ label: "REST", description: "REST API" },
		{ label: "GraphQL", description: "Graph API" },
	],
};
const theme = {
	fg: (_role: string, text: string) => text,
	bg: (_role: string, text: string) => text,
	bold: (text: string) => text,
};
type Component = { handleInput?(data: string): void; render(width: number): string[] };
type Factory = (
	tui: never,
	theme: never,
	kb: never,
	done: (value: QuestionnaireResult | null) => void,
) => Component;

function harness(controller: AbortController, delayed = false) {
	let tool!: ToolDefinition;
	const events = createEventBus();
	const states: string[] = [];
	events.on("pix:agent-state", (event) => states.push((event as { state: string }).state));
	registerAsk({
		events,
		registerTool: (value: ToolDefinition) => {
			tool = value;
		},
	} as never);
	let component!: Component;
	let open!: () => void;
	let dismiss!: () => void;
	let fail!: (error: Error) => void;
	let finishes = 0;
	let opens = 0;
	const result = tool.execute(
		"ask",
		{ questions: [question, question] },
		controller.signal,
		undefined,
		{
			hasUI: true,
			ui: {
				custom: (factory: Factory) =>
					new Promise<QuestionnaireResult | null>((resolve, reject) => {
						dismiss = () => resolve(null);
						fail = reject;
						open = () => {
							opens++;
							component = factory(
								{ terminal: { rows: 40 }, requestRender() {} } as never,
								theme as never,
								getKeybindings() as never,
								(value) => {
									finishes++;
									resolve(value);
								},
							);
						};
						if (!delayed) open();
					}),
			},
		} as never,
	);
	return {
		result,
		states,
		open: () => open(),
		dismiss: () => dismiss(),
		fail: (error: Error) => fail(error),
		get component() {
			return component;
		},
		get finishes() {
			return finishes;
		},
		get opens() {
			return opens;
		},
	};
}

test("normal completion preserves answers, removes abort listener and ignores late input", async () => {
	const controller = new AbortController();
	const h = harness(controller);
	expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
	h.component.handleInput?.("\r");
	h.component.handleInput?.("\r");
	const result = await h.result;
	expect(result.details).toMatchObject({
		answers: [{ answer: "REST" }, { answer: "REST" }],
		cancelled: false,
	});
	expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	controller.abort();
	h.component.handleInput?.("\r");
	expect(h.finishes).toBe(1);
	expect(h.states.at(-1)).toBe("idle");
});

test("cancel before a delayed factory closes it exactly once without constructing a questionnaire", async () => {
	const controller = new AbortController();
	const h = harness(controller, true);
	controller.abort();
	h.open();
	const result = await h.result;
	expect(result.details).toMatchObject({ answers: [], cancelled: true });
	expect(h.component.handleInput).toBeUndefined();
	expect(h.component.render(40).join("").trim()).toBe("");
	expect(h.finishes).toBe(1);
	expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	expect(h.states.at(-1)).toBe("idle");
});

test("active abort closes once and ignores late questionnaire completion", async () => {
	const controller = new AbortController();
	const h = harness(controller);
	controller.abort();
	expect((await h.result).details).toMatchObject({ answers: [], cancelled: true });
	h.component.handleInput?.("\r");
	h.component.handleInput?.("\r");
	expect(h.finishes).toBe(1);
	expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
});

for (const failure of [false, true]) {
	test(`host ${failure ? "failure" : "dismissal"} releases abort subscription`, async () => {
		const controller = new AbortController();
		const h = harness(controller);
		if (failure) {
			h.fail(new Error("UI failed"));
			await expect(h.result).rejects.toThrow("UI failed");
		} else {
			h.dismiss();
			expect((await h.result).details).toMatchObject({ cancelled: true });
		}
		controller.abort();
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
		expect(h.finishes).toBe(0);
		expect(h.states.at(-1)).toBe("idle");
	});
}

test("user cancellation preserves partial answers", async () => {
	const controller = new AbortController();
	const h = harness(controller);
	h.component.handleInput?.("\r");
	h.component.handleInput?.("\x03");
	expect((await h.result).details).toMatchObject({
		answers: [{ answer: "REST" }],
		cancelled: true,
	});
	expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
});

test("pre-aborted calls do not open a modal", async () => {
	const controller = new AbortController();
	controller.abort();
	const h = harness(controller);
	expect((await h.result).details).toMatchObject({ answers: [], cancelled: true });
	expect(h.opens).toBe(0);
});
