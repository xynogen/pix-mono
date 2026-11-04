import { describe, expect, test } from "bun:test";
import { colorToRgb, rgbColor, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { fadeLine, fadeRowsOf, fadeText, fadeTextRow } from "./text.ts";

describe("fadeTextRow", () => {
	const theme = { fg: (key: string, text: string) => `<${key}>${text}</${key}>` };
	const hint = (n: number) => `+${n}`;
	const body = Array.from({ length: 12 }, (_, i) => `\x1b[1mL${i}\x1b[22m`).join("\n");

	test("returns a short body unchanged", () => {
		expect(fadeTextRow("a\nb", theme, hint, 8)).toBe("a\nb");
	});

	test("keeps the head, fades the last rows (muted on a plain theme), then the hint", () => {
		const rows = fadeTextRow(body, theme, hint, 9, 3).split("\n");
		expect(rows).toHaveLength(10);
		expect(rows[5]).toBe("\x1b[1mL5\x1b[22m");
		expect(rows.slice(6, 9)).toEqual([
			"<muted>L6</muted>",
			"<muted>L7</muted>",
			"<muted>L8</muted>",
		]);
		expect(rows[9]).toBe("+3");
	});

	test("fades at most a third of a short preview and keeps padding uncolored", () => {
		const padded = Array.from({ length: 6 }, (_, i) => `   P${i}`);
		const rows = fadeRowsOf(padded, theme, 4, 3);
		expect(rows).toEqual(["   P0", "   P1", "   P2", "   <muted>P3</muted>"]);
	});

	test("blank rows take no fade step: the steps land on the last rows with text", () => {
		const rows = fadeRowsOf(["A", "B", "C", "D", "", "E", "F", "G", "H", "I"], theme, 9, 3);
		expect(rows).toEqual([
			"A",
			"B",
			"C",
			"D",
			"",
			"E",
			"<muted>F</muted>",
			"<muted>G</muted>",
			"<muted>H</muted>",
		]);
		const gap = fadeRowsOf(["A", "B", "C", "D", "E", "F", "G", "", "H", "I"], theme, 9, 3);
		expect(gap.slice(5)).toEqual(["<muted>F</muted>", "<muted>G</muted>", "", "<muted>H</muted>"]);
	});

	test("fades toward the background but never reaches it", () => {
		const reds: number[] = [];
		// dim is red, background is black: the red channel measures how far each row faded.
		const colors = {
			dim: rgbColor(255, 0, 0),
			customMessageBg: rgbColor(0, 0, 0),
		};
		const style = (text: string, { fg }: { fg: Parameters<typeof colorToRgb>[0] }) => {
			reds.push(colorToRgb(fg).r);
			return text;
		};
		fadeTextRow(body, { ...theme, colors, style }, hint, 9, 3);
		expect(reds).toHaveLength(3);
		// Painted bottom-up: the last row is faintest but still above the background.
		const [last = 0, middle = 0, first = 0] = reds;
		expect(first).toBeGreaterThan(middle);
		expect(middle).toBeGreaterThan(last);
		expect(last).toBeGreaterThan(0);
	});
});

describe("fadeText", () => {
	test("leaves fitting text to the caller with no fade", () => {
		const calls: [string, number][] = [];
		const result = fadeText("hello", 5, (text, fade) => {
			calls.push([text, fade]);
			return `[${text}]`;
		});
		expect(result).toBe("[hello]");
		expect(calls).toEqual([["hello", 0]]);
	});

	test("clips overflow and supplies a caller-controlled fade ramp", () => {
		const calls: [string, number][] = [];
		const result = fadeText(
			"abcdefghijk",
			8,
			(text, fade) => {
				calls.push([text, fade]);
				return text;
			},
			4,
		);
		expect(result).toBe("abcdefgh");
		expect(calls).toEqual([
			["abcd", 0],
			["e", 0.25],
			["f", 0.5],
			["g", 0.75],
			["h", 1],
		]);
	});

	test("supports hard clipping, fractional widths, and oversized fades", () => {
		expect(fadeText("abcdef", 3.8, (text) => text, 0)).toBe("abc");
		const levels: number[] = [];
		fadeText(
			"abcdef",
			2,
			(text, fade) => {
				levels.push(fade);
				return text;
			},
			20,
		);
		expect(levels).toEqual([0.5, 1]);
		for (const width of [-1, 0, 0.9, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(
				fadeText("abcdef", width, () => {
					throw new Error("Must not paint");
				}),
			).toBe("");
		}
	});

	test("does not split wide or combining graphemes at clip or fade boundaries", () => {
		const segments: string[] = [];
		const text = fadeText(
			"a界e\u0301🙂z",
			6,
			(part) => {
				segments.push(part);
				return part;
			},
			4,
		);
		expect(text).toBe("a界e\u0301🙂");
		expect(segments).toEqual(["a", "界", "e\u0301", "🙂"]);
		for (const input of ["界e\u0301🙂".repeat(10), "👨‍👩‍👧‍👦".repeat(10)]) {
			for (let width = 0; width < 40; width++) {
				const levels: number[] = [];
				const result = fadeText(input, width, (part, fade) => {
					levels.push(fade);
					return part;
				});
				expect(visibleWidth(result)).toBeLessThanOrEqual(width);
				expect(levels.every((n) => n >= 0 && n <= 1)).toBe(true);
			}
		}
	});

	test("strips incoming terminal controls before handing text to the caller", () => {
		const input = "\x1b[31mred\x1b[0m\n\x1b]8;;https://example.com\x07link\x1b]8;;\x07\tend";
		const result = fadeText(input, 40, (text) => `\x1b[32m${text}\x1b[39m`);
		expect(stripTerminalSequences(result)).toBe("red link end");
	});
});

describe("fadeLine", () => {
	test("returns a fitting styled line unchanged", () => {
		const line = "\x1b[31mok\x1b[39m";
		expect(fadeLine(line, 10, () => "X")).toBe(line);
	});

	test("keeps the styled head and fades the last columns instead of an ellipsis", () => {
		const line = `\x1b[31m${"abcdefghij"}\x1b[39m\x1b[32m${"klmnopqrst"}\x1b[39m`;
		const levels: number[] = [];
		const result = fadeLine(
			line,
			12,
			(text, fade) => {
				levels.push(fade);
				return `<${text}>`;
			},
			4,
		);
		expect(stripTerminalSequences(result)).toBe("abcdefgh<i><j><k><l>");
		expect(result.startsWith("\x1b[31mabcdefgh")).toBe(true);
		expect(levels).toEqual([0.25, 0.5, 0.75, 1]);
		for (let width = 0; width < 25; width++)
			expect(visibleWidth(fadeLine(line, width, (t) => t))).toBeLessThanOrEqual(width);
	});
});
