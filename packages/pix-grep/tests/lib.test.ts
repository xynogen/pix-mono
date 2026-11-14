import { expect, test } from "bun:test";
import type { GrepMatch } from "@ff-labs/fff-node";
import { countRipgrepMatches, fffFormatGrepText } from "../src/lib.ts";

test("countRipgrepMatches counts match and context records only", () => {
	expect(countRipgrepMatches("a.ts:1:x\na.ts-2-y\n\nnot a record\n")).toBe(2);
});

test("fffFormatGrepText writes ripgrep-style records with context and escapes newlines", () => {
	// SAFETY: the formatter reads only these fields of GrepMatch.
	const match = {
		relativePath: "a.ts",
		lineNumber: 3,
		lineContent: "hit\r\n",
		contextBefore: ["b1", "b2"],
		contextAfter: ["x\ny"],
	} as GrepMatch;
	expect(fffFormatGrepText([match], 10)).toBe("a.ts-1-b1\na.ts-2-b2\na.ts:3:hit\na.ts-4-x\\ny");
	expect(fffFormatGrepText([], 10)).toBe("No matches found");
});
