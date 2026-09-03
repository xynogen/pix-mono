/**
 * ask.test.ts — tests for the ask questionnaire tool
 *
 * Tests cover pure functions (schema validation, sentinel logic, answer
 * formatting). TUI components are not tested here.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { modalOverlayOptions } from "@xynogen/pix-pretty/modal-frame";
import {
	buildResponseText,
	formatAnswerScalar,
	hasAnyPreview,
	type OptionData,
	type QuestionData,
	sentinelsFor,
} from "./index.ts";

afterEach(() => {
	delete (globalThis as { __pixOnce?: WeakMap<object, Set<string>> }).__pixOnce;
});

// ── Fixtures ──────────────────────────────────────────────────────────

const opt = (label: string, description = "Test option", preview?: string): OptionData => ({
	label,
	description,
	...(preview ? { preview } : {}),
});

const qSingle: QuestionData = {
	question: "Which approach?",
	header: "Approach",
	options: [opt("REST", "Traditional REST API"), opt("GraphQL", "Query language for APIs")],
};

const qMulti: QuestionData = {
	question: "Which features?",
	header: "Features",
	options: [
		opt("Auth", "User authentication"),
		opt("Search", "Full text search"),
		opt("Export", "Data export"),
	],
	multiSelect: true,
};

const qWithPreview: QuestionData = {
	question: "Pick a component?",
	header: "Component",
	options: [
		opt("Button", "Clickable button", "<Button>Primary</Button>"),
		opt("Card", "Container card", "<Card><Content/></Card>"),
	],
};

const qSingleNoPreview: QuestionData = {
	question: "Color?",
	header: "Color",
	options: [opt("Red", "Ruby red"), opt("Blue", "Ocean blue")],
};

// ── hasAnyPreview ─────────────────────────────────────────────────────

describe("hasAnyPreview", () => {
	test("returns false when no option has preview", () => {
		expect(hasAnyPreview(qSingle)).toBe(false);
		expect(hasAnyPreview(qMulti)).toBe(false);
	});

	test("returns true when at least one option has preview", () => {
		expect(hasAnyPreview(qWithPreview)).toBe(true);
	});

	test("returns false for empty options", () => {
		const q: QuestionData = { question: "?", header: "X", options: [] };
		expect(hasAnyPreview(q)).toBe(false);
	});
});

// ── sentinelsFor ──────────────────────────────────────────────────────

describe("sentinelsFor", () => {
	test('single-select without preview appends "Type something."', () => {
		const r = sentinelsFor(qSingleNoPreview);
		expect(r).toHaveLength(1);
		expect(r[0]?.kind).toBe("other");
		expect(r[0]?.label).toBe("Type something.");
	});

	test('single-select WITH preview still appends "Type something."', () => {
		const r = sentinelsFor(qWithPreview);
		expect(r).toHaveLength(1);
		expect(r[0]?.kind).toBe("other");
		expect(r[0]?.label).toBe("Type something.");
	});

	test('multi-select appends "Type something." then "Confirm" at the bottom', () => {
		const r = sentinelsFor(qMulti);
		expect(r).toHaveLength(2);
		expect(r[0]?.kind).toBe("other");
		expect(r[0]?.label).toBe("Type something.");
		expect(r[1]?.kind).toBe("next");
		expect(r[1]?.label).toBe("Confirm");
	});

	test("every question type offers freeform (user can reject all options)", () => {
		for (const q of [qSingle, qSingleNoPreview, qWithPreview, qMulti]) {
			expect(sentinelsFor(q).some((s) => s.kind === "other")).toBe(true);
		}
	});

	test("empty options still gets freeform sentinel", () => {
		const r = sentinelsFor({ question: "?", header: "X", options: [] });
		expect(r).toHaveLength(1);
		expect(r[0]?.kind).toBe("other");
	});
});

// ── formatAnswerScalar ────────────────────────────────────────────────

describe("formatAnswerScalar", () => {
	test("option kind returns the answer string", () => {
		const a = {
			questionIndex: 0,
			question: "Q",
			kind: "option" as const,
			answer: "REST",
		};
		expect(formatAnswerScalar(a)).toBe("REST");
	});

	test("multi kind joins selected with comma", () => {
		const a = {
			questionIndex: 0,
			question: "Q",
			kind: "multi" as const,
			answer: null,
			selected: ["Auth", "Search"],
		};
		expect(formatAnswerScalar(a)).toBe("Auth, Search");
	});

	test("custom kind returns the typed text", () => {
		const a = {
			questionIndex: 0,
			question: "Q",
			kind: "custom" as const,
			answer: "my custom answer",
		};
		expect(formatAnswerScalar(a)).toBe("my custom answer");
	});

	test("chat kind returns (chat)", () => {
		const a = {
			questionIndex: 0,
			question: "Q",
			kind: "chat" as const,
			answer: null,
		};
		expect(formatAnswerScalar(a)).toBe("(chat)");
	});
});

// ── buildResponseText ─────────────────────────────────────────────────

describe("buildResponseText", () => {
	test("formats single answer", () => {
		const answers = [
			{
				questionIndex: 0,
				question: "Which approach?",
				kind: "option" as const,
				answer: "REST",
			},
		];
		const text = buildResponseText(answers, [qSingle]);
		expect(text).toContain("REST");
		expect(text).toContain("Which approach?");
	});

	test("formats multi-select answer", () => {
		const answers = [
			{
				questionIndex: 0,
				question: "Which features?",
				kind: "multi" as const,
				answer: null,
				selected: ["Auth", "Search"],
			},
		];
		const text = buildResponseText(answers, [qMulti]);
		expect(text).toContain("Auth, Search");
		expect(text).toContain("Which features?");
	});

	test("includes preview in response when present", () => {
		const answers = [
			{
				questionIndex: 0,
				question: "Pick a component?",
				kind: "option" as const,
				answer: "Button",
				preview: "<Button>Primary</Button>",
			},
		];
		const text = buildResponseText(answers, [qWithPreview]);
		expect(text).toContain("preview: <Button>Primary</Button>");
	});

	test("formats multiple answers", () => {
		const qs = [qSingle, qMulti];
		const answers = [
			{
				questionIndex: 0,
				question: "Which approach?",
				kind: "option" as const,
				answer: "GraphQL",
			},
			{
				questionIndex: 1,
				question: "Which features?",
				kind: "multi" as const,
				answer: null,
				selected: ["Export"],
			},
		];
		const text = buildResponseText(answers, qs);
		expect(text).toContain("GraphQL");
		expect(text).toContain("Export");
	});

	test("shows declined message when no answers", () => {
		const text = buildResponseText([], [qSingle]);
		expect(text).toContain("declined");
	});

	test("names unanswered questions on partial close", () => {
		const qs = [qSingle, qMulti];
		const answers = [
			{
				questionIndex: 0,
				question: "Which approach?",
				kind: "option" as const,
				answer: "GraphQL",
			},
		];
		const text = buildResponseText(answers, qs);
		expect(text).toContain("GraphQL");
		expect(text).toContain("Unanswered");
		expect(text).toContain(qMulti.question);
	});
});

// ── Tool registration shape ─────────────────────────────────────────

describe("registerAsk", () => {
	test("exports a default function", async () => {
		const mod = await import("./index.ts");
		expect(typeof mod.default).toBe("function");
	});

	test("renders shared call and terminal result rows", async () => {
		let tool:
			| {
					renderShell?: unknown;
					renderCall: (...args: any[]) => { render: (width: number) => string[] };
					renderResult: (...args: any[]) => { render: (width: number) => string[] };
			  }
			| undefined;
		const pi = {
			registerTool(definition: typeof tool) {
				tool = definition;
			},
		};
		const { default: registerAsk } = await import("./index.ts");
		registerAsk(pi as never);
		if (!tool) throw new Error("ask_user not registered");
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		const state = { collapsed: false };
		const call = tool
			.renderCall({ questions: [qSingle] }, theme, {
				expanded: false,
				state,
				invalidate: () => {},
			})
			.render(120)
			.join("\n")
			.trimEnd();
		expect(tool.renderShell).toBe("self");
		expect(call).toBe("ask_user Which approach? · 1 question");

		state.collapsed = true;
		const result = tool
			.renderResult(
				{
					content: [{ type: "text", text: "answer" }],
					details: {
						answers: [
							{ questionIndex: 0, question: qSingle.question, kind: "option", answer: "REST" },
						],
					},
				},
				{ expanded: false, isPartial: false },
				theme,
				{ expanded: false, state, invalidate: () => {}, isError: false },
			)
			.render(120)
			.join("\n")
			.trimEnd();
		expect(result).toBe("✓  ask_user REST · 1 answer");

		state.collapsed = false;
		const expanded = tool
			.renderResult(
				{
					content: [{ type: "text", text: "answer" }],
					details: {
						answers: [
							{ questionIndex: 0, question: qSingle.question, kind: "option", answer: "REST" },
						],
					},
				},
				{ expanded: true, isPartial: false },
				theme,
				{ expanded: true, state, invalidate: () => {}, isError: false },
			)
			.render(40);
		expect(expanded[0]).toBe("─".repeat(40));
		expect(expanded.at(-1)).toBe("─".repeat(40));

		const partial = tool
			.renderResult(
				{ content: [{ type: "text", text: "" }], details: undefined },
				{ expanded: true, isPartial: true },
				theme,
				{ expanded: true, state: {}, invalidate: () => {}, isError: false },
			)
			.render(40);
		expect(partial).toHaveLength(1);
		expect(partial[0]?.trimEnd()).toBe("Waiting for user input…");
	});

	test("frames expanded errors red but keeps cancellation compact", async () => {
		let tool:
			| { renderResult: (...args: any[]) => { render: (width: number) => string[] } }
			| undefined;
		const pi = {
			registerTool(definition: typeof tool) {
				tool = definition;
			},
		};
		const { default: registerAsk } = await import("./index.ts");
		registerAsk(pi as never);
		if (!tool) throw new Error("ask_user not registered");
		const theme = {
			fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
			bold: (text: string) => text,
		};
		const error = tool
			.renderResult(
				{ content: [{ type: "text", text: "At least one question is required." }] },
				{ expanded: true, isPartial: false },
				theme,
				{ expanded: true, state: {}, invalidate: () => {}, isError: true },
			)
			.render(40);
		expect(error[0]).toBe(`[error]${"─".repeat(40)}[/error]`);

		const noColorTheme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		};
		const cancelled = tool
			.renderResult(
				{ content: [{ type: "text", text: "Cancelled" }], details: { cancelled: true } },
				{ expanded: true, isPartial: false },
				noColorTheme,
				{ expanded: true, state: {}, invalidate: () => {}, isError: false },
			)
			.render(40);
		expect(cancelled).toHaveLength(1);
		expect(cancelled[0]).toContain("cancelled");
	});

	test("fills its overlay width so background content cannot bleed through on the right", async () => {
		let tool: { execute: (...args: any[]) => Promise<unknown> } | undefined;
		const pi = {
			events: createEventBus(),
			registerTool(definition: typeof tool) {
				tool = definition;
			},
		};
		const { default: registerAsk } = await import("./index.ts");
		registerAsk(pi as never);
		if (!tool) throw new Error("ask_user not registered");

		await tool.execute("id", { questions: [qSingle] }, undefined, undefined, {
			hasUI: true,
			ui: {
				custom: async (
					factory: (...args: any[]) => { render: (width: number) => string[] },
					options: unknown,
				) => {
					expect(options).toEqual({ overlay: true, overlayOptions: modalOverlayOptions() });
					const component = factory(
						{ terminal: { rows: 40 }, requestRender() {} },
						{
							fg: (_color: string, text: string) => text,
							bg: (_color: string, text: string) => text,
							bold: (text: string) => text,
						},
						{ matches: () => false },
						() => {},
					);
					expect(component.render(96).every((line) => visibleWidth(line) === 96)).toBe(true);
					return { answers: [], cancelled: true };
				},
			},
		});
	});

	test("reports blocked while waiting for user input", async () => {
		const events = createEventBus();
		const states: string[] = [];
		events.on("pix:agent-state", (event) => states.push((event as { state: string }).state));
		let tool: { execute: (...args: any[]) => Promise<unknown> } | undefined;
		const pi = {
			events,
			registerTool(definition: typeof tool) {
				tool = definition;
			},
		};
		const { default: registerAsk } = await import("./index.ts");
		registerAsk(pi as never);
		if (!tool) throw new Error("ask_user not registered");

		await tool.execute("id", { questions: [qSingle] }, undefined, undefined, {
			hasUI: true,
			ui: {
				custom: async () => ({
					answers: [
						{ questionIndex: 0, question: qSingle.question, kind: "option", answer: "REST" },
					],
					cancelled: false,
				}),
			},
		});

		expect(states).toContain("blocked");
		expect(states.at(-1)).toBe("idle");
	});
});
