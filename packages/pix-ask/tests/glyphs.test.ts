import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { checkboxGlyphs, selectionGlyph } from "../src/glyphs.ts";

describe("selectionGlyph", () => {
	test("multi checked → ▣ / success", () => {
		expect(selectionGlyph({ multi: true, selected: false, checked: true })).toEqual({
			glyph: "▣",
			color: "success",
		});
	});

	test("multi unchecked → ☐ / dim", () => {
		expect(selectionGlyph({ multi: true, selected: true, checked: false })).toEqual({
			glyph: "☐",
			color: "dim",
		});
	});

	test("radio selected → ◉ / accent", () => {
		expect(selectionGlyph({ multi: false, selected: true, checked: false })).toEqual({
			glyph: "◉",
			color: "accent",
		});
	});

	test("radio unselected → ○ / dim", () => {
		expect(selectionGlyph({ multi: false, selected: false, checked: false })).toEqual({
			glyph: "○",
			color: "dim",
		});
	});
});

describe("checkboxGlyphs", () => {
	test("checked and unchecked have equal display width", () => {
		const { checked, unchecked } = checkboxGlyphs();
		expect(visibleWidth(checked)).toBe(visibleWidth(unchecked));
	});
});
