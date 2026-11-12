import { describe, expect, it } from "bun:test";
import { filterModelWarnings, stripModelWarningParagraphs } from "../src/tool-result-filter.ts";

// ── stripModelWarningParagraphs ───────────────────────────────────────────────

describe("stripModelWarningParagraphs", () => {
	it("passes through text with no warnings", () => {
		const text = "Exit code: 0\n\nsome output here";
		expect(stripModelWarningParagraphs(text)).toBe(text);
	});

	it("strips a BLIND WRITE paragraph", () => {
		const text =
			"Exit code: 0\n\nsome output\n\n⚠ BLIND WRITE — editing `foo.ts` without reading in the last 5 tool calls. Read the file first to avoid assumptions.";
		const result = stripModelWarningParagraphs(text);
		expect(result).not.toContain("BLIND WRITE");
		expect(result).toContain("some output");
	});

	it("strips a THRASHING paragraph", () => {
		const text =
			"ok\n\n🔴 THRASHING — 3 consecutive `edit` calls on foo.ts. Consider reading first.";
		const result = stripModelWarningParagraphs(text);
		expect(result).not.toContain("THRASHING");
		expect(result).toContain("ok");
	});

	it("strips multiple warning paragraphs", () => {
		const text = "output\n\n⚠ BLIND WRITE — foo\n\n🔴 THRASHING — bar\n\nmore output";
		const result = stripModelWarningParagraphs(text);
		expect(result).not.toContain("BLIND WRITE");
		expect(result).not.toContain("THRASHING");
		expect(result).toContain("output");
		expect(result).toContain("more output");
	});

	it("returns original reference when nothing stripped", () => {
		const text = "no warnings here";
		expect(stripModelWarningParagraphs(text)).toBe(text);
	});

	it("trims trailing whitespace after stripping", () => {
		const text = "output\n\n⚠ BLIND WRITE — foo";
		const result = stripModelWarningParagraphs(text);
		expect(result).toBe("output");
	});

	it("does not strip mid-paragraph BLIND WRITE mentions", () => {
		// Only strips when the paragraph *starts* with the prefix
		const text = "The BLIND WRITE check is a feature.\n\nsome output";
		expect(stripModelWarningParagraphs(text)).toBe(text);
	});
});

// ── filterModelWarnings ───────────────────────────────────────────────────────

describe("filterModelWarnings", () => {
	it("returns original array when no warnings present", () => {
		const content = [{ type: "text" as const, text: "clean output" }];
		expect(filterModelWarnings(content)).toBe(content);
	});

	it("filters BLIND WRITE from text block", () => {
		const content = [
			{
				type: "text" as const,
				text: "Exit code: 0\n\nok\n\n⚠ BLIND WRITE — editing `x.ts` without reading.",
			},
		];
		const result = filterModelWarnings(content);
		expect(result).not.toBe(content);
		expect(result[0]?.type).toBe("text");
		if (result[0]?.type === "text") {
			expect((result[0] as { type: string; text: string }).text).not.toContain("BLIND WRITE");
		}
	});

	it("leaves image blocks untouched", () => {
		const img = { type: "image", source: { type: "base64", data: "abc" } };
		const content = [img] as never[];
		expect(filterModelWarnings(content)).toBe(content);
	});

	it("only modifies affected blocks, keeps others by reference", () => {
		const clean = { type: "text" as const, text: "clean" };
		const dirty = {
			type: "text" as const,
			text: "output\n\n⚠ BLIND WRITE — foo",
		};
		const content = [clean, dirty];
		const result = filterModelWarnings(content);
		// The array is new but clean block is the same reference
		expect(result[0]).toBe(clean);
		expect(result[1]).not.toBe(dirty);
	});
});
