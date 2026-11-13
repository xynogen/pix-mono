import { describe, expect, it } from "bun:test";
import { printableChar, sanitizeDisplayText, sanitizeRowContent } from "../src/panel-text.ts";

describe("sanitizeDisplayText", () => {
	it("drops escapes and folds controls and whitespace into single spaces", () => {
		expect(sanitizeDisplayText("\x1b]8;;http://x\x07a\x1b[31mb\x1b[0m\t\n c ")).toBe("ab c");
		expect(sanitizeDisplayText(null)).toBe("");
	});
});

describe("sanitizeRowContent", () => {
	it("keeps our styling and newlines, drops OSC, folds other controls", () => {
		expect(sanitizeRowContent("\x1b[1ma\x1b[22m\nb\x1b]0;title\x07\tc\x07d")).toBe(
			"\x1b[1ma\x1b[22m\nb c d",
		);
	});
});

describe("printableChar", () => {
	it("reads legacy and Kitty CSI-u printable keys, rejects control keys", () => {
		expect(printableChar("a")).toBe("a");
		expect(printableChar("\x1b[97u")).toBe("a");
		expect(printableChar("\x1b[97;5u")).toBeUndefined();
		expect(printableChar("\x01")).toBeUndefined();
		expect(printableChar("ab")).toBeUndefined();
	});
});
