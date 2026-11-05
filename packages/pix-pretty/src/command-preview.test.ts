import { expect, test } from "bun:test";
import {
	rgbColor,
	stripTerminalSequences,
	styleText,
	type TextStyle,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { collapsedCommandRow, commandPreview } from "./command-preview.ts";

const theme = { fg: (_key: string, text: string) => text };

test("marked command body aligns with the title column", () => {
	const preview = commandPreview(
		"◐  codemode",
		"first\nsecond",
		undefined,
		theme,
		{},
		() => {},
		false,
		3,
	);
	const rows = preview.render(40);
	expect(rows.slice(1).map((row) => row.slice(0, 3))).toEqual(["   ", "   "]);
	expect(rows[1]).toBe("   first");
	expect(rows[2]).toBe("   second");
});

test("command preview separates parameters, wraps without dropping text, and bounds collapse", async () => {
	const code = 'printf "a quoted value" && echo next';
	const state = {};
	const preview = commandPreview("ssh user@host", code, "bash", theme, state, () => {});
	await Promise.resolve();
	expect(preview.render(100).join("\n")).toContain("ssh user@host ·");
	const rows = preview.render(24);
	expect(rows.length).toBeGreaterThan(2);
	for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(24);
	const collapsed = collapsedCommandRow("ssh user@host", code, theme).render(24);
	expect(collapsed).toHaveLength(1);
	expect(collapsed[0]).toBe('ssh user@host · printf "');
	expect(visibleWidth(collapsed[0] ?? "")).toBeLessThanOrEqual(24);
	preview.setText("");
	expect(preview.render(24)).toEqual([]);
	const row = collapsedCommandRow("bash", "echo ok", theme);
	row.setText("line one\nline two");
	expect(row.render(24).map((line) => line.trimEnd())).toEqual(["line one", "line two"]);
});

test("collapsed command fades at the current viewport width without losing expandable text", () => {
	const fadeTheme = {
		...theme,
		colors: { dim: rgbColor(180, 180, 180), customMessageBg: rgbColor(20, 20, 20) },
		style: (text: string, style: TextStyle) => styleText(text, style, "truecolor"),
	};
	const command = "echo 界e\u0301🙂".repeat(30);
	const component = collapsedCommandRow("bash · 12 lines", command, fadeTheme);
	for (const width of [30, 60, 90]) {
		const rows = component.render(width);
		expect(rows).toHaveLength(1);
		expect(stripTerminalSequences(rows[0]!)).toStartWith("bash · 12 lines · echo");
		expect(visibleWidth(rows[0]!)).toBeLessThanOrEqual(width);
		expect(rows[0]).toContain("\x1b[38;2;20;20;20m");
	}
	for (let width = 0; width < 30; width++) {
		expect(visibleWidth(component.render(width)[0]!)).toBeLessThanOrEqual(width);
	}
	expect(stripTerminalSequences(component.getText())).toEndWith(command);
});

test("plain previews and unchanged highlighting do not schedule redundant renders", async () => {
	for (const language of [undefined, "javascript"]) {
		let invalidations = 0;
		const preview = commandPreview("codemode", "return 1;", language, theme, {}, () => {
			invalidations++;
		});
		const rows = preview.render(80);
		await Promise.resolve();
		expect(preview.render(80)).toEqual(rows);
		expect(invalidations).toBe(0);
	}
});

test.each([
	"bash",
	"powershell",
	"javascript",
])("%s previews highlight only after streaming arguments finish", async (language) => {
	const theme = { fg: (key: string, text: string) => `<${key}>${text}</${key}>` };
	const state = {};
	let invalidations = 0;
	const ctx = { executionStarted: false };
	const invalidate = () => invalidations++;
	for (const code of ["echo", "echo hello", "echo hello\necho world"]) {
		const preview = commandPreview("tool", code, language, theme, state, invalidate, false, 3, ctx);
		const rows = preview.render(24);
		expect(preview.getText()).toEndWith(code);
		await Promise.resolve();
		expect(preview.render(24)).toEqual(rows);
		expect(invalidations).toBe(0);
	}
	ctx.executionStarted = true;
	const code = language === "javascript" ? "return 1;" : "echo hello";
	const preview = commandPreview("tool", code, language, theme, state, invalidate, false, 3, ctx);
	await Promise.resolve();
	expect(invalidations).toBe(1);
	expect(state).toMatchObject({ commandPreview: { language, code } });
	expect(preview.render(80).length).toBeGreaterThan(0);
	commandPreview("tool", code, language, theme, state, invalidate, false, 3, ctx);
	await Promise.resolve();
	expect(invalidations).toBe(1);
});
