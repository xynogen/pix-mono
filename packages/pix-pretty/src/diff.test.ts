import { describe, expect, it } from "bun:test";
import { parseDiff } from "./diff.js";
import {
	DEFAULT_DIFF_COLORS,
	diffThemeCacheKey,
	renderDiffSummary,
	renderUnified,
	resolveDiffColors,
} from "./diff-render.js";

const OLD = "line1\nline2\nline3";
const NEW = "line1\nCHANGED\nline3";
const ANSI_RE = /\x1b\[[0-9;]*m|<\/?syntax\w+>/g;

describe("theme-derived diff rendering", () => {
	const theme = {
		fg: (key: string, text: string) => `<${key}>${text}</${key}>`,
		getFgAnsi: (key: string) => {
			if (key === "toolDiffAdded") return "\x1b[38;2;120;210;150m";
			if (key === "toolDiffRemoved") return "\x1b[38;2;230;120;130m";
			if (key === "toolDiffContext") return "\x1b[38;2;130;140;150m";
			return "";
		},
	};

	it("uses semantic foregrounds", () => {
		const colors = resolveDiffColors(theme);
		expect(colors.fgAdd).toBe("\x1b[38;2;120;210;150m");
		expect(colors.fgDel).toBe("\x1b[38;2;230;120;130m");
		expect(colors.fgCtx).toBe("\x1b[38;2;130;140;150m");
	});

	// Regression: these six slots were all set to BG_BASE (\x1b[49m), which
	// dropped the faint green/red row tint and left only the gutter chips
	// colored. A diff must read as add/remove bands at a glance.
	it("gives changed rows a faint tint background", () => {
		for (const colors of [DEFAULT_DIFF_COLORS, resolveDiffColors(theme)]) {
			for (const key of [
				"bgAdd",
				"bgDel",
				"bgAddHighlight",
				"bgDelHighlight",
				"bgGutterAdd",
				"bgGutterDel",
			] as const) {
				expect(colors[key]).not.toBe("\x1b[49m");
				expect(colors[key]).toMatch(/^\x1b\[48;2;\d+;\d+;\d+m$/);
			}
			// Word-diff emphasis must be distinguishable from the row tint.
			expect(colors.bgAddHighlight).not.toBe(colors.bgAdd);
			expect(colors.bgDelHighlight).not.toBe(colors.bgDel);
			// Add and remove must never collide.
			expect(colors.bgAdd).not.toBe(colors.bgDel);
		}
	});

	it("includes semantic theme colors in cache identity", () => {
		const changed = { ...theme, getFgAnsi: () => "\x1b[38;2;1;2;3m" };
		expect(diffThemeCacheKey(theme)).not.toBe(diffThemeCacheKey(changed));
	});

	it("colors persisted plain summaries only at render time", () => {
		expect(renderDiffSummary("+3 -2", theme)).toBe(
			"<toolDiffAdded>+3</toolDiffAdded> <toolDiffRemoved>-2</toolDiffRemoved>",
		);
		expect(renderDiffSummary("no changes", theme)).toBe(
			"<toolDiffContext>no changes</toolDiffContext>",
		);
	});

	it("emits tint backgrounds on changed rows", async () => {
		const rendered = await renderUnified(
			parseDiff("const oldValue = 1;", "const newValue = 2;"),
			"typescript",
			80,
			resolveDiffColors({ ...theme, fg: (_key, text) => text }),
		);
		const { bgAdd, bgDel } = resolveDiffColors(theme);
		expect(rendered).toContain(bgDel);
		expect(rendered).toContain(bgAdd);
	});

	it("keeps gutter numbering and rule layout intact", async () => {
		const rendered = await renderUnified(
			parseDiff("const oldValue = 1;", "const newValue = 2;"),
			"typescript",
			80,
			resolveDiffColors({ ...theme, fg: (_key, text) => text }),
		);
		const lines = rendered.replace(ANSI_RE, "").split("\n");

		expect(lines).toHaveLength(4);
		expect(lines[0]).toMatch(/^─+$/);
		expect(lines[1]).toMatch(/^▌\s+1- │ const oldValue = 1;\s*$/);
		expect(lines[2]).toMatch(/^▌\s+1\+ │ const newValue = 2;\s*$/);
		expect(lines[3]).toMatch(/^─+$/);
		expect(rendered).toContain(theme.getFgAnsi("toolDiffRemoved"));
		expect(rendered).toContain(theme.getFgAnsi("toolDiffAdded"));
	});
});

describe("parseDiff baseLine", () => {
	it("is snippet-relative when baseLine omitted (default 0)", () => {
		const { lines } = parseDiff(OLD, NEW);
		const del = lines.find((l) => l.type === "del");
		expect(del?.oldNum).toBe(2); // line2 is the 2nd line of the snippet
	});

	it("shifts gutter numbers to absolute when baseLine given", () => {
		// Snippet begins at file line 84 → snippet line 2 becomes file line 85.
		const { lines } = parseDiff(OLD, NEW, 3, 84);
		const del = lines.find((l) => l.type === "del");
		const add = lines.find((l) => l.type === "add");
		expect(del?.oldNum).toBe(85);
		expect(add?.newNum).toBe(85);
	});
});
