import { describe, expect, it } from "bun:test";
import { getTextContent, makeActionResult, setResultDetails } from "../src/result.ts";

it("makeActionResult prefers the error, then the lines, then '<action> ok'", () => {
	const base = { action: "add", ok: true, lines: [] as string[] };
	expect(makeActionResult(base)).toEqual({
		content: [{ type: "text", text: "add ok" }],
		details: base,
		isError: false,
	});
	expect(makeActionResult({ ...base, lines: ["a", "b"] }).content[0]?.text).toBe("a\nb");
	const failed = makeActionResult({ ...base, ok: false, lines: ["x"], error: "boom" });
	expect(failed.content[0]?.text).toBe("boom");
	expect(failed.isError).toBe(true);
});

it("extracts ordered text blocks without trimming whitespace or mutating mixed content", () => {
	const result = {
		details: undefined,
		content: [
			{ type: "text" as const, text: "  first\r\n" },
			{ type: "image" as const, data: "AA==", mimeType: "image/png" },
			{ type: "text" as const, text: "" },
			{ type: "text" as const, text: "last  " },
		],
	};
	const before = structuredClone(result);
	expect(getTextContent(result)).toBe("  first\r\n\n\nlast  ");
	expect(getTextContent({ content: [], details: undefined })).toBe("");
	expect(result).toEqual(before);
});

describe("setResultDetails", () => {
	it("preserves upstream metadata while adding renderer details", () => {
		const result = {
			content: [{ type: "text" as const, text: "output" }],
			details: {
				truncation: { truncated: true, totalLines: 500 },
				fullOutputPath: "/tmp/full.log",
			},
		};

		setResultDetails(result, { _type: "bashResult", exitCode: 0 });

		expect(result.details as Record<string, unknown>).toEqual({
			truncation: { truncated: true, totalLines: 500 },
			fullOutputPath: "/tmp/full.log",
			_type: "bashResult",
			exitCode: 0,
		});
	});
});
