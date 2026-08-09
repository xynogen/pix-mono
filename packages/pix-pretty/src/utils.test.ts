import { describe, expect, it } from "bun:test";

import { MAX_PREVIEW_LINES } from "./config.js";
import type { FgTheme } from "./types.js";
import {
	dotJoin,
	formatCollapsedToolRow,
	formatJson,
	hideCollapsedToolCall,
	padIcon,
	pluralize,
	renderCollapsedToolRow,
	renderDimPreview,
	ruleFrame,
	setResultDetails,
} from "./utils.js";

// Strip ANSI escapes so assertions test content, not color codes.
const ANSI = /\x1b\[[0-9;]*m/g;
function plain(text: string): string {
	return text.replace(ANSI, "");
}

describe("ruleFrame", () => {
	it("wraps body with a rule top and bottom, then footer below the close", () => {
		const out = ruleFrame(["a", "b"], ["… +3 more"], 10);
		expect(out).toHaveLength(5);
		expect(plain(out[0]!)).toBe("─".repeat(10)); // top rule
		expect(out.slice(1, 3)).toEqual(["a", "b"]); // body
		expect(plain(out[3]!)).toBe("─".repeat(10)); // bottom rule closes the block
		expect(plain(out[4]!)).toBe("… +3 more"); // footer after the close
	});

	it("closes the block even with no footer", () => {
		const out = ruleFrame(["only"], [], 4);
		expect(plain(out[0]!)).toBe("────");
		expect(plain(out.at(-1)!)).toBe("────");
	});

	it("paints both rules via the supplied paint fn, neutral by default", () => {
		const green = (s: string) => `<G>${s}</G>`;
		const ok = ruleFrame(["x"], [], 4, green);
		expect(ok[0]).toBe("<G>────</G>");
		expect(ok.at(-1)).toBe("<G>────</G>"); // both top and bottom rule painted
		const neutral = ruleFrame(["x"], [], 4);
		expect(neutral[0]).toContain("50;50;50"); // FG_RULE default tint
	});
});

describe("dotJoin", () => {
	it("joins non-empty parts with a middot, dropping falsy pieces", () => {
		expect(dotJoin(["a", "b", "c"])).toBe("a · b · c");
		expect(dotJoin(["a", "", null, undefined, false, "b"])).toBe("a · b");
		expect(dotJoin(["only"])).toBe("only");
		expect(dotJoin([])).toBe("");
	});

	it("paints the separator when a paint fn is supplied", () => {
		expect(dotJoin(["a", "b"], (s) => `<${s}>`)).toBe("a< · >b");
	});
});

// Minimal theme: fg() passes text through untouched.
const theme: FgTheme = { fg: (_key, text) => text };

describe("pluralize", () => {
	it("uses singular for count of 1", () => {
		expect(pluralize(1, "match", "matches")).toBe("1 match");
	});

	it("uses plural for count != 1", () => {
		expect(pluralize(0, "match", "matches")).toBe("0 matches");
		expect(pluralize(2, "match", "matches")).toBe("2 matches");
	});

	it("defaults plural to noun + s", () => {
		expect(pluralize(1, "line")).toBe("1 line");
		expect(pluralize(3, "line")).toBe("3 lines");
	});
});

describe("formatJson", () => {
	it("reindents a JSON string into a multiline block", () => {
		expect(formatJson('{"a":1,"b":2}')).toBe('{\n  "a": 1,\n  "b": 2\n}');
	});

	it("reindents an object value", () => {
		expect(formatJson({ a: 1 })).toBe('{\n  "a": 1\n}');
	});

	it("falls back to the raw string for non-JSON input", () => {
		expect(formatJson("not json")).toBe("not json");
	});

	it("reindenting a mega JSON one-liner breaks it into short, still-valid lines", () => {
		// A JSON one-liner is the pathological render case. Reindenting alone splits
		// it into short lines; it must NOT be hard-wrapped (that would split string
		// values mid-token) so the block stays valid JSON for syntax highlighting.
		const obj = { results: Array.from({ length: 300 }, (_, i) => ({ i, name: `item-${i}` })) };
		const mega = JSON.stringify(obj); // one long line
		const out = formatJson(mega, { wrapWidth: 80, maxLines: 9999 });
		expect(out.split("\n").length).toBeGreaterThan(300); // broken into many lines
		expect(() => JSON.parse(out)).not.toThrow(); // still valid JSON → highlightable
	});

	it("hard-wraps a NON-JSON mega-line but leaves JSON untouched", () => {
		// A genuine non-JSON one-liner (multi-KB plain string) still gets wrapped so
		// the TUI never measures a single huge line.
		const plain = "x".repeat(7806); // not JSON
		const wrapped = formatJson(plain, { wrapWidth: 80, maxLines: 9999 });
		const lines = wrapped.split("\n");
		expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(80);
		expect(wrapped.replace(/\n/g, "").length).toBe(plain.length); // lossless
	});

	it("caps line count with a `+N more` footer", () => {
		const obj = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, i]));
		const out = formatJson(obj, { maxLines: 10 });
		const lines = out.split("\n");
		expect(lines.length).toBe(11); // 10 + footer
		expect(lines.at(-1)).toMatch(/^… \+\d+ more$/);
	});

	it("applies a hard char ceiling as a last-resort guard", () => {
		const out = formatJson({ blob: "y".repeat(5000) }, { maxChars: 100, maxLines: 999 });
		expect(out.length).toBeLessThanOrEqual(100);
		expect(out.endsWith("…")).toBe(true);
	});
});

describe("collapsed tool rows", () => {
	const rowTheme = { fg: (_key: string, text: string) => text, bold: (text: string) => text };

	it("renders a consistent status, tool, target, and metadata row", () => {
		// The status marker is width-normalized to 2 cells (padIcon) so wide glyphs
		// align with narrow ones; a 1-cell `✓` therefore carries one pad space.
		expect(formatCollapsedToolRow(rowTheme, "read", "src/a.ts", "12 lines")).toBe(
			"✓  read src/a.ts · 12 lines",
		);
		const rendered = plain(renderCollapsedToolRow(rowTheme, "read", "src/a.ts", "12 lines"));
		expect(rendered).toStartWith("✓  read src/a.ts · 12 lines");
	});

	it("padIcon normalizes markers to a fixed cell width (per pi-tui visibleWidth)", () => {
		// pi-tui's width table drives the actual TUI column math, so padIcon trusts
		// it: `✓`/`✗`/`⚠` measure 1 cell and gain a pad space; `⚡` measures 2 and
		// is left as-is. All markers then occupy the same 2-cell column.
		expect(padIcon("✓")).toBe("✓ ");
		expect(padIcon("✗")).toBe("✗ ");
		expect(padIcon("⚠")).toBe("⚠ ");
		expect(padIcon("⚡")).toBe("⚡"); // already 2 cells — unchanged
		expect(padIcon("x", 4)).toBe("x   "); // explicit width
		expect(padIcon("⚡", 1)).toBe("⚡"); // never truncated below its own width
	});

	it("hides only collapsed, non-expanded call rows", () => {
		let value = "unchanged";
		expect(hideCollapsedToolCall({ collapsed: true }, false, (text) => (value = text))).toBe(true);
		expect(value).toBe("");
		expect(hideCollapsedToolCall({ collapsed: true }, true, () => {})).toBe(false);
	});
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

describe("renderDimPreview", () => {
	it("renders 'done' for empty input", () => {
		expect(plain(renderDimPreview("", theme))).toContain("done");
	});

	it("shows every line when under the cap", () => {
		const out = plain(renderDimPreview("a\nb\nc", theme));
		expect(out).toContain("a");
		expect(out).toContain("b");
		expect(out).toContain("c");
		expect(out).not.toContain("more line");
	});

	it("does not add overflow marker at exactly the cap", () => {
		const body = Array.from({ length: MAX_PREVIEW_LINES }, (_, i) => `L${i}`);
		const out = plain(renderDimPreview(body.join("\n"), theme));
		expect(out).not.toContain("more line");
	});

	it("adds singular overflow marker for 1 extra line", () => {
		const body = Array.from({ length: MAX_PREVIEW_LINES + 1 }, (_, i) => `L${i}`);
		const out = plain(renderDimPreview(body.join("\n"), theme));
		expect(out).toContain("… 1 more line");
		expect(out).not.toContain("more lines");
	});

	it("adds plural overflow marker for many extra lines", () => {
		const body = Array.from({ length: MAX_PREVIEW_LINES + 3 }, (_, i) => `L${i}`);
		const out = plain(renderDimPreview(body.join("\n"), theme));
		expect(out).toContain("… 3 more lines");
	});

	it("respects a custom maxLines", () => {
		const out = plain(renderDimPreview("a\nb\nc\nd", theme, { maxLines: 2 }));
		expect(out).toContain("… 2 more lines");
	});

	it("prepends a header line when given", () => {
		const out = plain(renderDimPreview("body", theme, { header: "5 matches" }));
		expect(out).toContain("5 matches");
		expect(out).toContain("body");
	});

	it("frames the body with a rule top and bottom, dropping the redundant header", () => {
		const out = plain(renderDimPreview("a\nb", theme, { frame: true, header: "2 files" }));
		const lines = out.split("\n");
		// No floating header in framed mode — the collapsed row carries the count.
		expect(out).not.toContain("2 files");
		expect(lines[0]).toMatch(/^─+$/); // top rule is the first line
		expect(lines.at(-1)).toMatch(/^─+$/); // bottom rule closes the block
	});

	it("paints the frame rules when a paint fn is given", () => {
		const tag: FgTheme = { fg: (k, v) => `<${k}>${v}` };
		const out = renderDimPreview("a\nb", tag, {
			frame: true,
			paint: (s: string) => tag.fg("success", s),
		});
		expect(out).toContain("<success>─");
	});

	it("frames overflow footer below the bottom rule", () => {
		const body = Array.from({ length: MAX_PREVIEW_LINES + 2 }, (_, i) => `L${i}`);
		const out = plain(renderDimPreview(body.join("\n"), theme, { frame: true }));
		const lines = out.split("\n");
		// overflow marker is the LAST line, below the closing rule
		expect(lines.at(-1)).toContain("… 2 more lines");
		expect(lines.at(-2)).toMatch(/^─+$/); // bottom rule sits above the footer
	});

	it("highlights matched keyword with non-dim styling", () => {
		const raw = renderDimPreview("foo bar foo", theme, { highlight: "foo" });
		// matched 'foo' wrapped in yellow/bold ANSI (not produced by stub fg)
		expect(raw).toContain("\x1b[");
		expect(plain(raw)).toContain("foo bar foo");
	});

	it("treats regex metacharacters as literal highlight text", () => {
		const raw = renderDimPreview("call(foo)", theme, { highlight: "(" });
		expect(plain(raw)).toContain("call(foo)");
		expect(raw).toContain("\x1b[");
	});
});
