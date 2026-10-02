import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
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
	expect(collapsed[0]).toContain("…");
	expect(visibleWidth(collapsed[0] ?? "")).toBeLessThanOrEqual(24);
	preview.setText("");
	expect(preview.render(24)).toEqual([]);
	const row = collapsedCommandRow("bash", "echo ok", theme);
	row.setText("line one\nline two");
	expect(row.render(24).map((line) => line.trimEnd())).toEqual(["line one", "line two"]);
});
