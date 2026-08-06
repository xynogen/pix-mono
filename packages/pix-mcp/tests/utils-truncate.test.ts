import { describe, expect, it } from "bun:test";
import { truncateAtWord } from "../src/utils.ts";

describe("truncateAtWord whitespace collapse", () => {
	it("collapses leading newlines/indent into a clean single line", () => {
		// composio-style descriptions start with "\n  Create or manage..."
		const out = truncateAtWord("\n  Create or manage connections to user's apps.  ", 50);
		expect(out.startsWith(" ")).toBe(false);
		expect(out).not.toContain("\n");
		expect(out).toBe("Create or manage connections to user's apps.");
	});

	it("collapses interior whitespace before truncating", () => {
		const out = truncateAtWord("Fast   and\n\tparallel tool executor for tools with many args", 20);
		expect(out).not.toContain("\n");
		expect(out).not.toContain("  ");
		expect(out.endsWith("...")).toBe(true);
	});

	it("returns empty input untouched", () => {
		expect(truncateAtWord("", 50)).toBe("");
	});
});
