import { describe, expect, it } from "bun:test";
import {
	capturePi,
	makeRenderCtx,
	makeTheme,
	makeToolContext,
} from "@xynogen/pix-pretty/test-utils";
import { applyGrepDefaults, DEFAULT_GREP_LIMIT, grepHighlight, registerGrepTool } from "./grep";

const noopFactory = () => ({ execute: async () => ({ content: [], details: undefined }) });

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

	it("restores matching lines when an elapsed card is expanded", () => {
		const { pi, tool } = capturePi();
		registerGrepTool(pi, noopFactory, makeToolContext());
		const output = "src/a.ts:1:TODO one\nsrc/b.ts:2:TODO two";
		const result = tool.renderResult?.(
			{
				content: [{ type: "text", text: output }],
				details: { _type: "grepResult", text: output, pattern: "TODO", matchCount: 2 },
			},
			undefined,
			makeTheme(),
			makeRenderCtx({ expanded: true, state: { collapsed: true } }),
		);

		const rendered = result?.getText() ?? "";
		expect(rendered).toContain("src/a.ts:1:");
		expect(rendered).toContain("TODO");
		expect(rendered).toContain("one");
		expect(rendered).toContain("src/b.ts:2:");
		expect(rendered).not.toContain("✓ grep");
	});

	it("frames single-match output like multi-match (no inline row)", () => {
		const { pi, tool } = capturePi();
		registerGrepTool(pi, noopFactory, makeToolContext());
		const theme = makeTheme();
		const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
		const result = {
			content: [{ type: "text", text: "src/a.ts:1:foo" }],
			details: {
				_type: "grepResult",
				text: "src/a.ts:1:foo",
				pattern: "foo",
				matchCount: 1,
			} as never,
		};
		const out =
			tool.renderResult?.(result, { isPartial: false }, theme, makeRenderCtx())?.getText() ?? "";
		// Single match is framed just like multi — one shape, no inline row.
		expect(out).toContain("─");
		expect(strip(out)).toContain("foo");
		expect(strip(out)).not.toContain("match");
		const multi = {
			content: [{ type: "text", text: "a:1:foo\nb:2:foo\nc:3:foo" }],
			details: {
				_type: "grepResult",
				text: "a:1:foo\nb:2:foo\nc:3:foo",
				pattern: "foo",
				matchCount: 3,
			} as never,
		};
		const multiOut =
			tool.renderResult?.(multi, { isPartial: false }, theme, makeRenderCtx())?.getText() ?? "";
		expect(multiOut).toContain("─");
	});

	it("collapses structured errors and restores the exact diagnostic on expansion", () => {
		const { pi, tool } = capturePi();
		registerGrepTool(pi, noopFactory, makeToolContext());
		const theme = makeTheme();
		const diagnostic = "regex parse error: unclosed group";
		const result = {
			content: [{ type: "text", text: diagnostic }],
			details: {
				_type: "grepResult",
				text: diagnostic,
				pattern: "(",
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
		expect(render({ collapsed: true })).toContain("✗  grep “(” in src · failed");
		expect(render({ collapsed: true }, true)).toContain(diagnostic);
	});
});
