/**
 * ask.test.ts — tests for the ask questionnaire tool
 *
 * Tests cover pure functions (schema validation, sentinel logic, answer
 * formatting). TUI components are not tested here.
 */

import { describe, expect, test } from "bun:test";
import {
	buildResponseText,
	formatAnswerScalar,
	hasAnyPreview,
	type OptionData,
	type QuestionData,
	sentinelsFor,
} from "./index.ts";

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
});

// ── Tool registration shape ─────────────────────────────────────────

describe("registerAsk", () => {
	test("exports a default function", async () => {
		const mod = await import("./index.ts");
		expect(typeof mod.default).toBe("function");
	});
});
