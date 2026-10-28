import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capturePi, makeToolContext } from "@xynogen/pix-pretty/test-utils";
import type { ToolResultLike } from "@xynogen/pix-pretty/types";
import { anchor, initHashline } from "@xynogen/pix-runtime/hashline";
import { tempDir } from "@xynogen/pix-runtime/paths";
import {
	anchorGrepText,
	applyGrepDefaults,
	DEFAULT_GREP_LIMIT,
	grepHighlight,
	registerGrepTool,
	stripGrepAnchors,
} from "./grep";

beforeAll(initHashline);

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

describe("case handling matches the ripgrep fallback", () => {
	it("FFF runs case-sensitive; ignoreCase goes to the SDK, which honours it", async () => {
		const seen: Array<{ smartCase?: boolean }> = [];
		const finder = {
			isDestroyed: false,
			grep: (_pattern: string, opts: { smartCase?: boolean }) => {
				seen.push(opts);
				return { ok: true, value: { items: [], totalMatched: 0 } };
			},
		};
		const sdkCalls: Array<{ ignoreCase?: boolean }> = [];
		const factory = (() => ({
			execute: async (_id: string, params: { ignoreCase?: boolean }) => {
				sdkCalls.push(params);
				return { content: [{ type: "text", text: "" }], details: undefined };
			},
		})) as unknown as typeof noopFactory;
		const { pi, tool } = capturePi();
		registerGrepTool(pi, factory, { ...makeToolContext(), fffState: { finder } } as never);
		const execute = tool.execute as (...args: unknown[]) => Promise<ToolResultLike>;

		await execute("t1", { pattern: "todo" }, undefined, undefined, {});
		expect(seen).toEqual([expect.objectContaining({ smartCase: false })]);
		expect(sdkCalls).toHaveLength(0);

		await execute("t2", { pattern: "TODO", ignoreCase: true }, undefined, undefined, {});
		expect(seen).toHaveLength(1); // FFF skipped: it cannot do ignoreCase
		expect(sdkCalls).toEqual([expect.objectContaining({ ignoreCase: true })]);
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

describe("grep anchors", () => {
	const source = "const a = 1;\nexport function target() {\n\treturn a;\n}\n";

	it("match rows carry the same LINE#HASH as read, from the full source line", async () => {
		const dir = mkdtempSync(join(tempDir(), "pix-grep-anchor-"));
		try {
			writeFileSync(join(dir, "src.ts"), source);
			const want = `src.ts:${anchor(2, "export function target() {")}|export function target() {`;
			// FFF rows: `path:LINE:text`; Pi ripgrep rows: `path:LINE: text` and `path-LINE- ctx`.
			expect(await anchorGrepText("src.ts:2:export function target() {", dir, "")).toBe(want);
			const sdk = await anchorGrepText(
				"src.ts-1- const a = 1;\nsrc.ts:2: export function target() {",
				dir,
				" ",
			);
			expect(sdk.split("\n")).toEqual(["src.ts-1- const a = 1;", want]);
			// A file search root names rows by basename.
			expect(
				await anchorGrepText("src.ts:2: export function target() {", join(dir, "src.ts"), " "),
			).toBe(want);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("leaves rows it cannot resolve unchanged and the renderer strips hashes", async () => {
		const dir = mkdtempSync(join(tempDir(), "pix-grep-anchor-"));
		try {
			const rows = "missing.ts:3:x\nNo matches found";
			expect(await anchorGrepText(rows, dir, "")).toBe(rows);
			expect(stripGrepAnchors("a/b.ts:12#ABC|text\nother")).toBe("a/b.ts:12:text\nother");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
