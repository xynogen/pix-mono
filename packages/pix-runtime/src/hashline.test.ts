import { expect, test } from "bun:test";
import { anchor, decodeLines, hashLine, initHashline, parseAnchor } from "./hashline";

test("shared initialization and canonical anchors", async () => {
	await Promise.all([initHashline(), initHashline()]);
	expect(hashLine("")).toBe("D05");
	expect(anchor(12, "")).toBe("12#D05");
	expect(parseAnchor("12#D05")).toEqual({ line: 12, hash: "D05" });
	for (const invalid of ["0#D05", "01#D05", "1#d05", "1#AAAA", "9007199254740992#D05"]) {
		expect(() => parseAnchor(invalid)).toThrow();
	}
	expect(hashLine(" x ")).not.toBe(hashLine("x"));
});

test("logical lines retain delimiters and BOM, with no phantom final line", () => {
	expect(decodeLines(Buffer.from("")).lines).toEqual([]);
	const file = decodeLines(Buffer.from("\uFEFFa\r\nb\rc\n"));
	expect(file).toEqual({
		bom: "\uFEFF",
		lines: [
			{ text: "a", ending: "\r\n" },
			{ text: "b", ending: "\r" },
			{ text: "c", ending: "\n" },
		],
		delimiter: "\r\n",
		finalNewline: true,
	});
	expect(decodeLines(Buffer.from("a\rb\nc\n")).delimiter).toBe("\n");
	expect(decodeLines(Buffer.from("a")).finalNewline).toBe(false);
	for (const bytes of [Buffer.from([0xff]), Buffer.from("a\0b")]) {
		expect(() => decodeLines(bytes)).toThrow();
	}
});
