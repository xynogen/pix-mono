import { describe, expect, test } from "bun:test";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../src/host.ts";
import { truncateOutput } from "../src/output.ts";

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");

describe("truncateOutput", () => {
	test("short and empty text pass through unchanged", () => {
		expect(truncateOutput("a\nb")).toEqual({ text: "a\nb", truncated: false });
		expect(truncateOutput("")).toEqual({ text: "", truncated: false });
	});

	test("line cap is inclusive", () => {
		expect(truncateOutput(lines(DEFAULT_MAX_LINES)).truncated).toBe(false);
		const over = truncateOutput(lines(DEFAULT_MAX_LINES + 1));
		expect(over.truncated).toBe(true);
		expect(over.text.split("\n")).toHaveLength(DEFAULT_MAX_LINES);
		expect(truncateOutput("a\nb\nc", 2)).toEqual({ text: "a\nb", truncated: true });
	});

	test("byte cap applies independently of line count", () => {
		const big = Array(4)
			.fill("x".repeat(20 * 1024))
			.join("\n");
		const out = truncateOutput(big);
		expect(out.truncated).toBe(true);
		expect(Buffer.byteLength(out.text)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
	});

	test("one line over the byte cap keeps a prefix on a UTF-8 boundary", () => {
		// truncateHead alone returns "" here.
		expect(truncateOutput("é".repeat(10), 2000, 5)).toEqual({ text: "éé", truncated: true });
		expect(truncateOutput("abcde", 2000, 3)).toEqual({ text: "abc", truncated: true });
		expect(truncateOutput("a\uFFFDz", 2000, 4)).toEqual({ text: "a\uFFFD", truncated: true });
		expect(truncateOutput("a😀z", 2000, 4)).toEqual({ text: "a", truncated: true });
	});
});
