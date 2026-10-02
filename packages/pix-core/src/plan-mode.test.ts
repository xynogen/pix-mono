import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { setIconMode } from "@xynogen/pix-pretty/icon-catalog";
import { tempDir } from "@xynogen/pix-runtime/paths";
import { attachModeKeys, isPlanPath, listPlans, modeStatus, parsePlan } from "./plan-mode.ts";

describe("listPlans", () => {
	it("sorts by modification time, newest first, then by file name", () => {
		const cwd = mkdtempSync(join(tempDir(), "plan-order-"));
		const dir = join(cwd, ".pi", "plans");
		try {
			mkdirSync(dir, { recursive: true });
			for (const [file, time] of [
				["z-old.md", 1000],
				["a-new.md", 2000],
				["b-new.md", 2000],
			] as const) {
				const path = join(dir, file);
				writeFileSync(path, "# Plan");
				utimesSync(path, time, time);
			}
			expect(listPlans(cwd).map((plan) => plan.file)).toEqual(["b-new.md", "a-new.md", "z-old.md"]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("modeStatus", () => {
	it("plan shows its icon in warning, normal shows another icon in muted", () => {
		setIconMode("ascii");
		const fg = (role: string, text: string) => `<${role}>${text}`;
		expect(modeStatus(true, fg)).toBe("<warning>P");
		expect(modeStatus(false, fg)).toBe("<muted>>");
	});
});

describe("attachModeKeys", () => {
	it("Shift+Tab toggles mode, Tab cycles thinking only in an empty prompt", () => {
		const tui = { requestRender() {} } as unknown as TUI;
		const editor = new CustomEditor(
			tui,
			{ borderColor: (t: string) => t, selectList: {} } as EditorTheme,
			{ matches: () => false } as unknown as KeybindingsManager,
		);
		let toggles = 0;
		let cycles = 0;
		editor.onAction("app.thinking.cycle", () => cycles++);
		attachModeKeys(editor, () => toggles++);
		editor.handleInput("\t");
		editor.handleInput("\x1b[Z");
		expect({ toggles, cycles, text: editor.getText() }).toEqual({
			toggles: 1,
			cycles: 1,
			text: "",
		});
		editor.handleInput("a");
		editor.handleInput("\t");
		editor.handleInput("\x1b[Z");
		expect({ toggles, cycles }).toEqual({ toggles: 2, cycles: 1 });
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
