import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import {
	flattenSvg,
	hasMermaid,
	renderMermaidBlocks,
	renderMermaidImage,
	startMermaid,
} from "../src/mermaid.js";

/** Columns and rows Pi's Image asked the terminal to draw. */
function size(rows: readonly string[] | undefined): { cols: number; rows: number } | undefined {
	const seq = rows?.find((row) => row.includes("\x1b_G")) ?? "";
	const cols = Number(/c=(\d+)/.exec(seq)?.[1]);
	const height = Number(/r=(\d+)/.exec(seq)?.[1]);
	return cols > 0 ? { cols, rows: height } : undefined;
}

const FLOW = 'flowchart TD\n  B["Brand"] --> H["Hardware"]\n  B --> S["Software"]';

beforeAll(() => startMermaid());
afterEach(() => resetCapabilitiesCache());

describe("mermaid", () => {
	it("inlines CSS variables and color-mix as hex for resvg", () => {
		const svg =
			'<svg style="--bg:#000000;--fg:#ffffff"><style>@import url(x); svg { --_line: var(--line, color-mix(in srgb, var(--fg) 50%, var(--bg))); }</style><path stroke="var(--_line)"/></svg>';
		const flat = flattenSvg(svg);
		expect(flat).toContain('stroke="#808080"');
		expect(flat).not.toMatch(/var\(|color-mix|<style>|@import/);
	});

	it("draws a diagram as an image sized to text rows, shrunk to fit narrow screens", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		const wide = size(renderMermaidImage(FLOW, 120));
		expect(wide?.rows).toBeGreaterThan(3);
		expect(wide?.cols).toBeLessThan(120);
		const narrow = size(renderMermaidImage(FLOW, 20));
		// Shrunk to leave room for the frame.
		expect(narrow?.cols).toBeLessThanOrEqual(14);
	});

	it("frames the diagram in a dim box like display math", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		const rows = renderMermaidImage(FLOW, 120) ?? [];
		const cols = size(rows)?.cols ?? 0;
		expect(rows[0]).toContain(`╭${"─".repeat(cols + 4)}╮`);
		expect(rows.at(-1)).toContain(`╰${"─".repeat(cols + 4)}╯`);
	});

	it("falls back to text without image support, and keeps unsupported diagrams as code", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		const out = renderMermaidBlocks(`a\n\`\`\`mermaid\n${FLOW}\n\`\`\`\nb`, 80);
		expect(out).toContain("│ Hardware │");
		expect(out).not.toContain("```mermaid");
		const pie = '```mermaid\npie\n  "a" : 1\n```';
		expect(renderMermaidBlocks(pie, 80)).toBe(pie);
	});

	it("replaces mermaid fences with an image and leaves other fences alone", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		const out = renderMermaidBlocks(`\`\`\`mermaid\n${FLOW}\n\`\`\`\n\`\`\`ts\nx\n\`\`\``, 80);
		expect(out.split("\n").filter((line) => line.includes("\x1b_G")).length).toBeGreaterThan(0);
		expect(out).toContain("```ts\nx\n```");
	});

	it("finds mermaid fences only in assistant text, as the install trigger", () => {
		const reply = (text: string, role = "assistant") => ({
			role,
			content: [{ type: "text", text }],
		});
		expect(hasMermaid([reply("```mermaid\nflowchart TD\n```")])).toBe(true);
		expect(hasMermaid([reply("talk about mermaid")])).toBe(false);
		expect(hasMermaid([reply("```mermaid\nx\n```", "user")])).toBe(false);
	});
});
