import { expect, test } from "bun:test";
import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import type { ThemeLike } from "@xynogen/pix-pretty/types";
import {
	attachSkillPicker,
	expandSkillTokens,
	type SkillItem,
	SkillPicker,
	skillToken,
} from "./picker.ts";

test("submit swaps <skill> tokens for Pi skill blocks before the user text", async () => {
	const errors: string[] = [];
	const out = await expandSkillTokens(
		"<skill>tdd</skill> fix bug <skill>gone</skill> <skill>tdd</skill>",
		async (ref) => {
			if (ref === "gone") throw new Error("skill not found");
			return { name: ref, location: "/s/tdd.md", baseDir: "/s", body: "BODY" };
		},
		(ref) => errors.push(ref),
	);
	expect(out).toBe(
		'<skill name="tdd" location="/s/tdd.md">\nReferences are relative to /s.\n\nBODY\n</skill>\n\nfix bug <skill>gone</skill>',
	);
	expect(errors).toEqual(["gone"]);
	expect(
		await expandSkillTokens(
			"plain text",
			async () => ({}) as never,
			() => {},
		),
	).toBeNull();
});

const theme = { fg: (_k: string, t: string) => t, bold: (t: string) => t } as ThemeLike;
const local: SkillItem[] = [
	{ name: "commit", detail: "write commits" },
	{ name: "tdd", detail: "test first" },
];

test("local skills filter by fuzzy name, remote results follow after the debounce", async () => {
	let chosen: SkillItem | null = null;
	const queries: string[] = [];
	let complete!: () => void;
	const completion = new Promise<void>((resolve) => {
		complete = resolve;
	});
	const picker = new SkillPicker({
		local,
		theme,
		delayMs: 0,
		search: async (q) => {
			queries.push(q);
			return [{ name: "tdd-pro", source: "acme/skills", detail: "acme/skills · 1.2K installs" }];
		},
		done: (item) => {
			chosen = item;
		},
		onChange: complete,
	});
	try {
		for (const ch of "td") picker.handleInput(ch);
		expect(picker.results().map((s) => s.name)).toEqual(["tdd"]);
		await completion;
		expect(queries).toEqual(["td"]);
		expect(picker.results().map((s) => s.name)).toEqual(["tdd", "tdd-pro"]);
		expect(picker.render(100).join("\n")).toMatch(/tdd-pro skills\.sh acme\/skills/);
		picker.handleInput("\x1b[B");
		picker.handleInput("\r");
		expect(chosen).toMatchObject({ name: "tdd-pro", source: "acme/skills" });
		expect(skillToken(chosen!)).toBe("<skill>acme/skills@tdd-pro</skill> ");
		expect(skillToken(local[0]!)).toBe("<skill>commit</skill> ");
	} finally {
		picker.dispose();
	}
});

test("boundary $ opens the picker, mid-word $ and cancel keep a literal $", async () => {
	const tui = { requestRender() {} } as unknown as TUI;
	const editor = new CustomEditor(
		tui,
		{ borderColor: (t: string) => t, selectList: {} } as EditorTheme,
		{
			matches: () => false,
		} as unknown as KeybindingsManager,
	);
	let next: SkillItem | null = local[1]!;
	let opens = 0;
	attachSkillPicker(
		editor,
		tui,
		async () => {
			opens++;
			return next;
		},
		() => {},
	);
	editor.handleInput("$");
	await Promise.resolve();
	expect(editor.getText()).toBe("<skill>tdd</skill> ");
	editor.handleInput("a");
	editor.handleInput("$");
	expect(opens).toBe(1);
	next = null;
	editor.handleInput(" ");
	editor.handleInput("$");
	await Promise.resolve();
	expect(opens).toBe(2);
	expect(editor.getText()).toBe("<skill>tdd</skill> a$ $");
});
