import { describe, expect, it } from "bun:test";
import {
	capturePi,
	makeRenderCtx,
	makeTheme,
	makeToolContext,
} from "@xynogen/pix-pretty/test-utils";
import { applyFindDefaults, DEFAULT_FIND_LIMIT, globHighlight, registerFindTool } from "./find";

const noopFactory = () => ({ execute: async () => ({ content: [], details: undefined }) });

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
		// Single result is framed just like multi — one shape, no inline row.
		expect(out).toContain("─");
		expect(strip(out)).toContain("src/a.ts");
		expect(strip(out)).not.toContain("file");
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
		expect(multiOut).toContain("─");
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
		expect(render({ timer: 1 })).toContain("─");
		expect(render({ collapsed: true })).toContain("✗  find [ in src · failed");
		expect(render({ collapsed: true }, true)).toContain(diagnostic);
	});
});
