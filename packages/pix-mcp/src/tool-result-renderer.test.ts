import { expect, test } from "bun:test";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { collapseSection } from "@xynogen/pix-runtime/sections";
import { withUiFixture } from "../../../scripts/ui-capture.ts";
import {
	colorizeToon,
	detectHighlightLang,
	formatMcpToolResultLines,
	renderMcpToolResult,
} from "./tool-result-renderer.ts";

// A theme that wraps each colored span in «key»… so assertions can see which
// semantic color each token got without matching raw ANSI.
const tagTheme = { fg: (k: string, t: string) => `«${k}»${t}` };

test("default terminal MCP results use a status-colored dashed close", () => {
	const result = { content: [{ type: "text" as const, text: "done" }], details: {} };
	const success = renderMcpToolResult(result, { expanded: false, isPartial: false }, tagTheme, {
		isError: false,
		expanded: false,
	}).render(40);
	const failed = renderMcpToolResult(
		{ ...result, details: { error: "failed" } },
		{ expanded: false, isPartial: false },
		tagTheme,
		{ isError: true, expanded: false },
	).render(40);

	expect(success[0]).toBe("«toolOutput»done");
	expect(success.at(-1)).toBe(`«success»${"- ".repeat(20)}`);
	expect(failed[0]).toBe("«toolOutput»done");
	expect(failed.at(-1)).toBe(`«error»${"- ".repeat(20)}`);
});

test("expanded MCP results use the same status-colored dashed close", () => {
	const result = { content: [{ type: "text" as const, text: "done" }], details: {} };
	const success = renderMcpToolResult(result, { expanded: true, isPartial: false }, tagTheme, {
		isError: false,
		expanded: true,
	}).render(8);
	const failed = renderMcpToolResult(
		{ ...result, details: { error: "failed" } },
		{ expanded: true, isPartial: false },
		tagTheme,
		{ isError: true, expanded: true },
	).render(8);

	expect(success[0]).toBe("«toolOut");
	expect(success.at(-1)).toBe("«success»- - - - ");
	expect(failed[0]).toBe("«toolOut");
	expect(failed.at(-1)).toBe("«error»- - - - ");
});

test("failed MCP results collapse with an error marker and expand the full diagnostic", async () => {
	const fixture = await withUiFixture();
	await fixture.runtime.update(collapseSection, (current) => ({
		...current,
		enabled: true,
		tools: {},
	}));
	try {
		const theme = { ...tagTheme, bold: (text: string) => text };
		const result = {
			content: [{ type: "text" as const, text: "upstream failed\nretry later" }],
			details: { error: "failed" },
		};
		const context = { state: { collapsed: true }, invalidate() {}, expanded: false, isError: true };
		const rows = renderMcpToolResult(
			result,
			{ expanded: false, isPartial: false },
			theme,
			context,
		).render(120);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain(icon("status.error"));
		expect(rows[0]).toContain("upstream failed");
		const expanded = renderMcpToolResult(result, { expanded: true, isPartial: false }, theme, {
			...context,
			expanded: true,
		}).render(120);
		expect(expanded.join("\n")).toContain("retry later");
		expect(expanded.at(-1)).toBe(`«error»${"- ".repeat(60)}`);
	} finally {
		await fixture.restore();
	}
});
test("detectHighlightLang: JSON object/array → json", () => {
	expect(detectHighlightLang('{"a":1}')).toBe("json");
	expect(detectHighlightLang("  [1,2,3]")).toBe("json");
});

test("detectHighlightLang: TOON key/value + array header → toon", () => {
	const toon = [
		"success: true",
		"result[1]{State,PublicId,Name}:",
		'  Done,"141",Improve toolbox rendering',
		"hasNext: true",
	].join("\n");
	expect(detectHighlightLang(toon)).toBe("toon");
	// A bare scalar line is enough.
	expect(detectHighlightLang("hasNext: false")).toBe("toon");
	// Slashed field names (workflow/state) still count as a key.
	expect(detectHighlightLang("workflow/state: Done")).toBe("toon");
});

test("detectHighlightLang: plain prose → null (left uncolored)", () => {
	expect(detectHighlightLang("just some text without a colon key")).toBeNull();
	expect(detectHighlightLang("")).toBeNull();
	// A colon mid-sentence is not a key header.
	expect(detectHighlightLang("see this: not a key line")).toBeNull();
});

test("colorizeToon: scalar values typed by kind", () => {
	expect(colorizeToon("success: true", tagTheme)).toBe(
		"«syntaxVariable»success«syntaxPunctuation»: «syntaxKeyword»true",
	);
	expect(colorizeToon("count: 42", tagTheme)).toBe(
		"«syntaxVariable»count«syntaxPunctuation»: «syntaxNumber»42",
	);
	expect(colorizeToon('name: "quoted"', tagTheme)).toBe(
		'«syntaxVariable»name«syntaxPunctuation»: «syntaxString»"quoted"',
	);
});

test("colorizeToon: array header colors count + column names", () => {
	expect(colorizeToon("result[1]{State,PublicId,Name}:", tagTheme)).toBe(
		"«syntaxVariable»result«syntaxNumber»[1]«syntaxPunctuation»{«syntaxType»State,PublicId,Name«syntaxPunctuation»}«syntaxPunctuation»:",
	);
});

test("colorizeToon: data row splits on unquoted commas, keeps quoted intact", () => {
	const out = colorizeToon('  Done,"141",Improve toolbox rendering', tagTheme);
	// The quoted "141" stays one string cell; the trailing bare text is one cell.
	expect(out).toBe(
		'  Done«syntaxPunctuation»,«syntaxString»"141"«syntaxPunctuation»,Improve toolbox rendering',
	);
});

test("colorizeToon: quoted comma is not a cell boundary", () => {
	expect(colorizeToon('  "a,b",c', tagTheme)).toBe('  «syntaxString»"a,b"«syntaxPunctuation»,c');
});

test("formatMcpToolResultLines: renders TOON as pretty JSON", () => {
	const toon = [
		"success: true",
		"result[1]{State,PublicId,Name}:",
		'  Done,"141","Improve toolbox rendering"',
		"hasNext: false",
	].join("\n");
	const display = formatMcpToolResultLines({ content: [{ type: "text", text: toon }] }, false, 80);

	expect(display).toEqual({
		lines: [
			"{",
			'  "success": true,',
			'  "result": [',
			"    {",
			'      "State": "Done",',
			'      "PublicId": "141",',
			'      "Name": "Improve toolbox rendering"',
			"    }",
			"  ],",
			'  "hasNext": false',
			"}",
		],
		truncated: false,
	});
});
