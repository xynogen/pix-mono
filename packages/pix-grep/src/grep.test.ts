import { describe, expect, it } from "bun:test";
import { capturePi, makeToolContext } from "@xynogen/pix-pretty/test-utils";
import type { ToolResultLike } from "@xynogen/pix-pretty/types";
import { applyGrepDefaults, DEFAULT_GREP_LIMIT, grepHighlight, registerGrepTool } from "./grep";

const noopFactory = () => ({ execute: async () => ({ content: [], details: undefined }) });

// Factory echoing one "hit" line per requested pattern (SDK path; finder is null in tests).
const echoFactory = (() => ({
	parameters: {
		type: "object",
		required: ["pattern"],
		properties: { pattern: { type: "string" } },
	},
	execute: async (_id: string, params: { pattern?: string }) => ({
		content: [{ type: "text", text: `file.ts:1:${params.pattern} hit` }],
		details: undefined,
	}),
})) as unknown as typeof noopFactory;

describe("applyGrepDefaults", () => {
	it("applies a conservative default without overriding an explicit limit", () => {
		expect(applyGrepDefaults({ pattern: "TODO" })).toEqual({
			pattern: "TODO",
			limit: DEFAULT_GREP_LIMIT,
		});
		expect(applyGrepDefaults({ pattern: "TODO", limit: 5 })).toEqual({
			pattern: "TODO",
			limit: 5,
		});
	});
});

describe("grepHighlight", () => {
	it("returns the raw string for a literal search (utils escapes it)", () => {
		expect(
			grepHighlight({
				_type: "grepResult",
				text: "",
				pattern: "a.b",
				matchCount: 0,
				literal: true,
			}),
		).toBe("a.b");
	});

	it("compiles a case-sensitive regex by default", () => {
		const re = grepHighlight({ _type: "grepResult", text: "", pattern: "te.t", matchCount: 0 });
		expect(re).toBeInstanceOf(RegExp);
		expect((re as RegExp).flags).toBe("g");
		expect((re as RegExp).test("test")).toBe(true);
	});

	it("adds the i flag when ignoreCase is set", () => {
		const re = grepHighlight({
			_type: "grepResult",
			text: "",
			pattern: "todo",
			matchCount: 0,
			ignoreCase: true,
		});
		expect((re as RegExp).flags).toBe("gi");
	});

	it("falls back to the literal source on an invalid regex", () => {
		expect(grepHighlight({ _type: "grepResult", text: "", pattern: "(", matchCount: 0 })).toBe("(");
	});
});

describe("registerGrepTool", () => {
	it("registers a tool named 'grep'", () => {
		const { pi, names } = capturePi();
		registerGrepTool(pi, noopFactory, makeToolContext());
		expect(names).toEqual(["grep"]);
	});

	it("searches multiple patterns in one call and combines into a batch result", async () => {
		const { pi, tool } = capturePi();
		registerGrepTool(pi, echoFactory, makeToolContext());
		const execute = tool.execute as (...args: unknown[]) => Promise<ToolResultLike>;
		const result = await execute("tid", { patterns: ["foo", "bar"] }, undefined, undefined, {});
		const d = result.details as { _type: string; patterns?: string[]; matchCount: number };
		expect(d._type).toBe("grepResult");
		expect(d.patterns).toEqual(["foo", "bar"]);
		expect(d.matchCount).toBe(2);
		const text = result.content?.[0];
		const body = text && "text" in text ? text.text : "";
		expect(body).toContain("===== foo =====");
		expect(body).toContain("bar hit");
	});

	it("keeps the single-search shape for one pattern", async () => {
		const { pi, tool } = capturePi();
		registerGrepTool(pi, echoFactory, makeToolContext());
		const execute = tool.execute as (...args: unknown[]) => Promise<ToolResultLike>;
		const result = await execute("tid", { pattern: "solo" }, undefined, undefined, {});
		const d = result.details as { _type: string; pattern: string; patterns?: string[] };
		expect(d._type).toBe("grepResult");
		expect(d.pattern).toBe("solo");
		expect(d.patterns).toBeUndefined();
	});
});
