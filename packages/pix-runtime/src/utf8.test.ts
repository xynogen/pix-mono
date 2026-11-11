import { expect, test } from "bun:test";
import { truncateOutput, truncateStringToBytes } from "./utf8.ts";

test("keeps the longest complete UTF-8 prefix for every byte boundary", () => {
	for (const text of ["", "ascii\n ", "café", "日本語", "a😀é中", "a\uFFFDz", "\uFEFFé\r\n"]) {
		for (let budget = 0; budget <= Buffer.byteLength(text) + 1; budget++) {
			let expected = "";
			for (const char of text) {
				if (Buffer.byteLength(expected + char) > budget) break;
				expected += char;
			}
			const actual = truncateStringToBytes(text, budget);
			expect(actual).toBe(expected);
			expect(Buffer.byteLength(actual)).toBeLessThanOrEqual(budget);
		}
	}
});

test("rejects invalid byte budgets", () => {
	for (const budget of [
		-1,
		1.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.MAX_SAFE_INTEGER + 1,
	]) {
		expect(() => truncateStringToBytes("hello", budget)).toThrow(RangeError);
	}
});

test("truncateOutput keeps a byte-capped prefix when the first line exceeds the cap", () => {
	expect(truncateOutput("a\nb")).toEqual({ text: "a\nb", truncated: false });
	expect(truncateOutput("a\nb\nc", 2)).toEqual({ text: "a\nb", truncated: true });
	// truncateHead alone returns "" here.
	expect(truncateOutput("é".repeat(10), 2000, 5)).toEqual({ text: "éé", truncated: true });
});
