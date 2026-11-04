import { describe, expect, it } from "bun:test";
import {
	capturePi,
	makeRenderCtx,
	makeTheme,
	makeToolContext,
} from "@xynogen/pix-pretty/test-utils";
import type { ToolResultLike } from "@xynogen/pix-pretty/types";
import { applyFindDefaults, DEFAULT_FIND_LIMIT, globHighlight, registerFindTool } from "./find";

const noopFactory = () => ({ execute: async () => ({ content: [], details: undefined }) });

// Factory echoing one matched path per requested glob (SDK path; finder is null in tests).
const echoFactory = (() => ({
	parameters: {
		type: "object",
		required: ["pattern"],
		properties: { pattern: { type: "string" } },
	},
	execute: async (_id: string, params: { pattern?: string }) => ({
		content: [{ type: "text", text: `match-for-${params.pattern}.ts` }],
		details: undefined,
	}),
})) as unknown as typeof noopFactory;

describe("globHighlight", () => {
	it("keeps literal runs from a glob as case-insensitive alternatives", () => {
		const re = globHighlight("**/*.test.ts");
		expect(re).toBeInstanceOf(RegExp);
		expect((re as RegExp).flags).toBe("gi");
		expect("foo.test.ts".match(re as RegExp)).not.toBeNull();
	});

	it("highlights the extension of a simple glob", () => {
		expect("app.ts".match(globHighlight("*.ts") as RegExp)?.[0]).toBe(".ts");
	});

	it("returns undefined when the glob has no meaningful literal run", () => {
		expect(globHighlight("*")).toBeUndefined();
	});
});

describe("applyFindDefaults", () => {
	it("applies a conservative default without overriding an explicit limit", () => {
		expect(applyFindDefaults({ pattern: "**/*.ts" })).toEqual({
			pattern: "**/*.ts",
			limit: DEFAULT_FIND_LIMIT,
		});
		expect(applyFindDefaults({ pattern: "**/*.ts", limit: 8 })).toEqual({
			pattern: "**/*.ts",
			limit: 8,
		});
	});
});

describe("registerFindTool", () => {
	it("registers a tool named 'find'", () => {
		const { pi, names } = capturePi();
		registerFindTool(pi, noopFactory, makeToolContext());
		expect(names).toEqual(["find"]);
	});

	it("searches multiple globs in one call and combines into a batch result", async () => {
		const { pi, tool } = capturePi();
		registerFindTool(pi, echoFactory, makeToolContext());
		const execute = tool.execute as (...args: unknown[]) => Promise<ToolResultLike>;
		const result = await execute("tid", { patterns: ["*.ts", "*.md"] }, undefined, undefined, {});
		const d = result.details as { _type: string; patterns?: string[]; matchCount: number };
		expect(d._type).toBe("findResult");
		expect(d.patterns).toEqual(["*.ts", "*.md"]);
		expect(d.matchCount).toBe(2);
		const text = result.content?.[0];
		const body = text && "text" in text ? text.text : "";
		expect(body).toContain("===== *.ts =====");
		expect(body).toContain("match-for-*.md.ts");
	});

	it("keeps the single-search shape for one glob", async () => {
		const { pi, tool } = capturePi();
		registerFindTool(pi, echoFactory, makeToolContext());
		const execute = tool.execute as (...args: unknown[]) => Promise<ToolResultLike>;
		const result = await execute("tid", { pattern: "*.ts" }, undefined, undefined, {});
		const d = result.details as { _type: string; pattern: string; patterns?: string[] };
		expect(d._type).toBe("findResult");
		expect(d.pattern).toBe("*.ts");
		expect(d.patterns).toBeUndefined();
	});

	it("restores result paths when an elapsed card is expanded", () => {
		const { pi, tool } = capturePi();
		registerFindTool(pi, noopFactory, makeToolContext());
		const result = tool.renderResult?.(
			{
				content: [{ type: "text", text: "src/one.ts\nsrc/two.ts" }],
				details: {
					_type: "findResult",
					text: "src/one.ts\nsrc/two.ts",
					pattern: "**/*.ts",
					matchCount: 2,
				},
			},
			undefined,
			makeTheme(),
			makeRenderCtx({ expanded: true, state: { collapsed: true } }),
		);

		const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
		const shown = strip(result?.getText() ?? "");
		expect(shown).toContain("src/one.ts");
		expect(shown).toContain("src/two.ts");
		// No floating count header in the framed view — the collapsed row carries it.
		expect(shown).not.toContain("2 files");
	});

	it("frames single-file output like multi-file (no inline row)", () => {
		const { pi, tool } = capturePi();
		registerFindTool(pi, noopFactory, makeToolContext());
		const theme = makeTheme();
		const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
		const result = {
			content: [{ type: "text", text: "src/a.ts" }],
			details: { _type: "findResult", text: "src/a.ts", pattern: "*.ts", matchCount: 1 } as never,
		};
		const out =
			tool.renderResult?.(result, { isPartial: false }, theme, makeRenderCtx())?.getText() ?? "";
		// Single result uses the same body + solid-close shape as multi-result output.
		const lines = strip(out).split("\n");
		expect(lines[0]).toContain("src/a.ts");
		expect(lines.at(-1)).toMatch(/^─{3,}$/);
		const multi = {
			content: [{ type: "text", text: "a.ts\nb.ts\nc.ts" }],
			details: {
				_type: "findResult",
				text: "a.ts\nb.ts\nc.ts",
				pattern: "*.ts",
				matchCount: 3,
			} as never,
		};
		const multiOut =
			tool.renderResult?.(multi, { isPartial: false }, theme, makeRenderCtx())?.getText() ?? "";
		expect(strip(multiOut).split("\n").at(-1)).toMatch(/^─{3,}$/);
	});

	it("collapses structured errors and restores the exact diagnostic on expansion", () => {
		const { pi, tool } = capturePi();
		registerFindTool(pi, noopFactory, makeToolContext());
		const theme = makeTheme();
		const diagnostic = "Invalid glob pattern: [";
		const result = {
			content: [{ type: "text", text: diagnostic }],
			details: {
				_type: "findResult",
				text: diagnostic,
				pattern: "[",
				path: "src",
				matchCount: 0,
			},
		};
		const render = (state: Record<string, unknown>, expanded = false) => {
			const component = tool.renderResult?.(
				result,
				{ isPartial: false },
				theme,
				makeRenderCtx({ isError: true, expanded, state }),
			);
			return component?.render(120).join("\n") ?? "";
		};

		expect(render({ timer: 1 })).toContain(diagnostic);
		expect(render({ timer: 1 })).toContain("───");
		expect(render({ collapsed: true })).toContain("✗  find [ in src · failed");
		expect(render({ collapsed: true }, true)).toContain(diagnostic);
	});
});
