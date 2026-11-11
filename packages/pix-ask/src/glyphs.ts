import { visibleWidth } from "@xynogen/pix-pretty/tui";

const CHECKBOX_CHECKED = "▣";
const CHECKBOX_UNCHECKED = "☐";
const RADIO_SELECTED = "◉";
const RADIO_UNSELECTED = "○";

/** Glyph + theme color token for a selection row. Caller applies theme.fg(color, glyph). */
export function selectionGlyph(opts: { multi: boolean; selected: boolean; checked: boolean }): {
	glyph: string;
	color: string;
} {
	if (opts.multi) {
		return opts.checked
			? { glyph: CHECKBOX_CHECKED, color: "success" }
			: { glyph: CHECKBOX_UNCHECKED, color: "dim" };
	}
	return opts.selected
		? { glyph: RADIO_SELECTED, color: "accent" }
		: { glyph: RADIO_UNSELECTED, color: "dim" };
}

/**
 * Checkbox glyph pair, falling back to ASCII [x]/[ ] when the unicode squares
 * do not measure as a single display cell (some terminals render
 * geometric-shape codepoints as width-2, breaking column alignment).
 */
export function checkboxGlyphs(): { checked: string; unchecked: string } {
	const unicodeSafe =
		visibleWidth(CHECKBOX_CHECKED) === 1 && visibleWidth(CHECKBOX_UNCHECKED) === 1;
	return unicodeSafe
		? { checked: CHECKBOX_CHECKED, unchecked: CHECKBOX_UNCHECKED }
		: { checked: "[x]", unchecked: "[ ]" };
}
