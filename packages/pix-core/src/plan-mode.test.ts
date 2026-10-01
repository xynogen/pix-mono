import { describe, expect, it } from "bun:test";
import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { setIconMode } from "@xynogen/pix-pretty/icon-catalog";
import { attachTabToggle, isPlanPath, modeStatus, parsePlan } from "./plan-mode.ts";

describe("modeStatus", () => {
	it("plan shows its icon in warning, normal shows another icon in muted", () => {
		setIconMode("ascii");
		const fg = (role: string, text: string) => `<${role}>${text}`;
		expect(modeStatus(true, fg)).toBe("<warning>P");
		expect(modeStatus(false, fg)).toBe("<muted>>");
	});
});

describe("attachTabToggle", () => {
	it("Tab toggles in an empty prompt and stays a normal key with text", () => {
		const tui = { requestRender() {} } as unknown as TUI;
		const editor = new CustomEditor(
			tui,
			{ borderColor: (t: string) => t, selectList: {} } as EditorTheme,
			{ matches: () => false } as unknown as KeybindingsManager,
		);
		let toggles = 0;
		attachTabToggle(editor, () => toggles++);
		editor.handleInput("	");
		editor.handleInput("	");
		expect(toggles).toBe(2);
		expect(editor.getText()).toBe("");
		editor.handleInput("a");
		editor.handleInput("	");
		expect(toggles).toBe(2);
		expect(editor.getText()).toStartWith("a");
	});
});

describe("parsePlan", () => {
	it("reads title, description, and body from frontmatter", () => {
		const p = parsePlan("a.md", "---\ntitle: Auth\ndescription: Add login\n---\n# Plan\nstep");
		expect(p).toEqual({
			file: "a.md",
			title: "Auth",
			description: "Add login",
			body: "# Plan\nstep",
		});
	});

	it("falls back to the file name without frontmatter", () => {
		expect(parsePlan("2025-01-01-x.md", "# body")).toMatchObject({
			title: "2025-01-01-x",
			body: "# body",
		});
	});
});

describe("isPlanPath", () => {
	it("accepts files inside .pi/plans", () => {
		expect(isPlanPath("/p", ".pi/plans/a.md")).toBe(true);
		expect(isPlanPath("/p", "/p/.pi/plans/a.md")).toBe(true);
	});

	it("rejects paths outside .pi/plans", () => {
		expect(isPlanPath("/p", "src/a.ts")).toBe(false);
		expect(isPlanPath("/p", ".pi/plans/../x.md")).toBe(false);
	});
});
