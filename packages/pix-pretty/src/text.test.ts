import { describe, expect, test } from "bun:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { fadeText } from "./text.ts";

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
