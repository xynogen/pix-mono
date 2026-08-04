/**
 * questionnaire-keys.test.ts — keyboard handling of the ask_user questionnaire.
 *
 * Regression tests for the Kitty keyboard protocol: digits and printable
 * characters arrive as CSI-u sequences under Kitty flag 1, so raw compares
 * (`data.match(/^[1-9]$/)`, ASCII-window checks) silently miss them. Asserts
 * digit-select and type-to-search under BOTH encodings, plus non-ASCII input.
 */

import { describe, expect, it } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, type TUI, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { AskQuestionnaire } from "./questionnaire.ts";
import type { Params } from "./schema.ts";
import type { QuestionnaireResult } from "./types.ts";

// CSI-u form: ESC [ <codepoint> u
const kitty = (ch: string): string => `\u001b[${ch.codePointAt(0)}u`;

const ENCODINGS = [
	{ name: "legacy", enc: (ch: string) => ch },
	{ name: "kitty", enc: kitty },
] as const;

const theme = {
	fg: (_c: string, t: string) => t,
	bg: (_c: string, t: string) => t,
	bold: (t: string) => t,
	italic: (t: string) => t,
	underline: (t: string) => t,
	strikethrough: (t: string) => t,
} as unknown as Theme;

const tui = {
	requestRender: () => {},
	terminal: { rows: 40, cols: 100 },
} as unknown as TUI;

function makeParams(): Params {
	return {
		questions: [
			{
				question: "Pick a fruit?",
				header: "Fruit",
				options: [
					{ label: "Apple", description: "red" },
					{ label: "Banana", description: "yellow" },
					{ label: "Cérise", description: "cherry, accented" },
				],
			},
		],
	} as Params;
}

function open(): {
	q: AskQuestionnaire;
	feed(data: string): void;
	result(): QuestionnaireResult | null | undefined;
	rendered(): string;
} {
	let result: QuestionnaireResult | null | undefined;
	const kb = new KeybindingsManager(TUI_KEYBINDINGS);
	const q = new AskQuestionnaire(makeParams(), tui, theme, kb, (r) => {
		result = r;
	});
	return {
		q,
		feed: (data) => q.handleInput(data),
		result: () => result,
		rendered: () => q.render(100).join("\n"),
	};
}

for (const { name, enc } of ENCODINGS) {
	describe(`questionnaire keys (${name} encoding)`, () => {
		it("digit 2 selects the second option and completes", () => {
			const d = open();
			d.feed(enc("2"));
			const res = d.result();
			expect(res).toBeDefined();
			expect(res?.answers[0]?.answer).toBe("Banana");
		});

		it("typed letters filter options via search", () => {
			const d = open();
			d.feed(enc("b"));
			d.feed(enc("a"));
			d.feed(enc("n"));
			const text = d.rendered();
			expect(text).toContain("Banana");
			expect(text).not.toContain("Apple");
		});
	});
}

// ── Freeform override (regardless of question type) ───────────────────

const DOWN = "\x1b[B";
const ENTER = "\r";

/** Drive an arbitrary questionnaire and collect its result. */
function drive(params: Params): {
	feed(data: string): void;
	result(): QuestionnaireResult | null | undefined;
} {
	let result: QuestionnaireResult | null | undefined;
	const kb = new KeybindingsManager(TUI_KEYBINDINGS);
	const q = new AskQuestionnaire(params, tui, theme, kb, (r) => {
		result = r;
	});
	return { feed: (d) => q.handleInput(d), result: () => result };
}

/** Navigate to the freeform ("Type something.") row, open it, type, submit. */
function overrideWith(d: { feed(data: string): void }, rowsToFreeform: number, text: string): void {
	for (let i = 0; i < rowsToFreeform; i++) d.feed(DOWN);
	d.feed(ENTER); // commitAnswer → open editor
	for (const ch of text) d.feed(ch);
	d.feed(ENTER); // editor submit → handleFreeformSubmit
}

describe("freeform override", () => {
	it("single-select with preview can be overridden by typing", () => {
		const params = {
			questions: [
				{
					question: "Pick a component?",
					header: "Component",
					options: [
						{ label: "Button", description: "clickable", preview: "<Button/>" },
						{ label: "Card", description: "container", preview: "<Card/>" },
					],
				},
			],
		} as Params;
		const d = drive(params);
		// rows: [Button, Card, Type something.] → 2 downs reach freeform
		overrideWith(d, 2, "my own component");
		const res = d.result();
		expect(res?.cancelled).toBe(false);
		expect(res?.answers[0]?.kind).toBe("custom");
		expect(res?.answers[0]?.answer).toBe("my own component");
	});

	it("multi-select can be overridden by typing instead of choosing options", () => {
		const params = {
			questions: [
				{
					question: "Which features?",
					header: "Features",
					options: [
						{ label: "Auth", description: "login" },
						{ label: "Search", description: "find" },
					],
					multiSelect: true,
				},
			],
		} as Params;
		const d = drive(params);
		// rows: [Auth, Search, Type something., Next] → 2 downs reach freeform
		overrideWith(d, 2, "none of these, do X");
		const res = d.result();
		expect(res?.cancelled).toBe(false);
		expect(res?.answers[0]?.kind).toBe("custom");
		expect(res?.answers[0]?.answer).toBe("none of these, do X");
	});
});

describe("questionnaire keys (non-ASCII input)", () => {
	it("accented characters reach the search query (legacy bytes)", () => {
		const d = open();
		d.feed("é");
		const text = d.rendered();
		expect(text).toContain("Cérise");
		expect(text).not.toContain("Banana");
	});

	it.each([
		["legacy C0", "\u0001"],
		["legacy DEL", "\u007f"],
		["Kitty DEL", "\u001b[127u"],
		["legacy C1 NEL", "\u0085"],
		["Kitty C1 NEL", "\u001b[133u"],
	])("%s controls never reach the search query", (_name, input) => {
		const d = open();
		d.feed(input);
		const text = d.rendered();
		// No filtering happened — all options still visible.
		expect(text).toContain("Apple");
		expect(text).toContain("Banana");
	});
});
