import { describe, expect, it } from "bun:test";

import { join } from "node:path";
import { MAX_PREVIEW_LINES } from "./config.ts";
import type { FgTheme } from "./types.ts";
import {
	BODY_PAD,
	bodyLine,
	dotJoin,
	fillToolBackground,
	formatCollapsedToolRow,
	formatJson,
	frameToolResult,
	frameToolSection,
	hideCollapsedToolCall,
	moreLines,
	padIcon,
	pluralize,
	renderCollapsedToolRow,
	renderDimPreview,
	rule,
	ruleFrame,
	sectionFrame,
	sectionRule,
	setResultDetails,
	shortPath,
	termW,
	unframeToolResult,
	viewportText,
} from "./utils.ts";

class MockTextComponent {
	private text = "";
	invalidations = 0;

	setText(value: string): void {
		this.text = value;
	}

	render(): string[] {
		return this.text.split("\n");
	}

	invalidate(): void {
		this.invalidations++;
	}
}

// Counting variant: records how often the inner component is re-fitted, so a
// regression that recomputes every frame (the pre-memo CPU bug) fails loudly.
class CountingTextComponent {
	static setCalls = 0;
	static renderCalls = 0;
	private text = "";
	setText(value: string): void {
		CountingTextComponent.setCalls++;
		this.text = value;
	}
	render(): string[] {
		CountingTextComponent.renderCalls++;
		return this.text.split("\n");
	}
	invalidate(): void {}
}

describe("viewportText", () => {
	it("trims a pre-filled row to Pi's narrower fullscreen viewport", () => {
		const text = viewportText(MockTextComponent);
		text.setText(fillToolBackground("tool", "", 10));

		expect(plain(text.render(9)[0]!)).toBe("tool".padEnd(9));
		expect(plain(text.render(10)[0]!)).toBe("tool".padEnd(10));
	});

	it("memoizes: repeat render at same width does not re-fit the inner component", () => {
		CountingTextComponent.setCalls = 0;
		const text = viewportText(CountingTextComponent);
		text.setText("line one\nline two");

		text.render(20);
		text.render(20);
		text.render(20);
		// One fit for the width; repeats hit the cache. Pre-memo this was 3.
		expect(CountingTextComponent.setCalls).toBe(1);
	});

	it("re-fits when width changes, but a return to a recent width hits the cache", () => {
		CountingTextComponent.setCalls = 0;
		CountingTextComponent.renderCalls = 0;
		const text = viewportText(CountingTextComponent);
		text.setText("abcdefghij");

		text.render(20);
		text.render(5); // new width → fit
		text.render(5); // same → cached
		text.render(20); // back to a recent width → cached, no re-fit
		text.render(5); // back again → cached
		expect(CountingTextComponent.setCalls).toBe(2);
		expect(CountingTextComponent.renderCalls).toBe(2);
		expect(text.render(20).map(plain)).toEqual(["abcdefghij"]);
		expect(text.render(5).map(plain)).toEqual(["abcde"]);
	});

	it("keeps at most 4 widths, then fits again", () => {
		CountingTextComponent.renderCalls = 0;
		const text = viewportText(CountingTextComponent);
		// Longer than every width, so each width has a different fit.
		text.setText("abcdefghijklmnopqrstuvwxyz");
		for (const w of [10, 11, 12, 13, 14]) text.render(w); // 5 widths → 10 is evicted
		expect(CountingTextComponent.renderCalls).toBe(5);
		text.render(14); // newest → cached
		expect(CountingTextComponent.renderCalls).toBe(5);
		text.render(10); // evicted → fit again
		expect(CountingTextComponent.renderCalls).toBe(6);
		expect(text.render(10).map(plain)).toEqual(["abcdefghij"]);
	});

	it("re-fits after setText changes the content", () => {
		CountingTextComponent.setCalls = 0;
		const text = viewportText(CountingTextComponent);
		text.setText("first");
		text.render(20);
		text.render(20); // cached
		text.setText("second"); // invalidates memo
		text.render(20); // re-fit
		expect(CountingTextComponent.setCalls).toBe(2);
	});

	it("setText with identical value is a no-op (no memo invalidation)", () => {
		CountingTextComponent.setCalls = 0;
		const text = viewportText(CountingTextComponent);
		text.setText("same");
		text.render(20);
		text.setText("same"); // identical → must not invalidate
		text.render(20); // still cached
		expect(CountingTextComponent.setCalls).toBe(1);
	});

	it("idle frames (same text+width) do not re-call the inner render", () => {
		CountingTextComponent.renderCalls = 0;
		const text = viewportText(CountingTextComponent);
		text.setText("line one\nline two");
		text.render(20);
		text.render(20);
		text.render(20);
		// One inner render for the width; spinner ticks reuse the memoized output.
		expect(CountingTextComponent.renderCalls).toBe(1);
	});

	it("re-calls inner render after content changes", () => {
		CountingTextComponent.renderCalls = 0;
		const text = viewportText(CountingTextComponent);
		text.setText("first");
		text.render(20);
		text.setText("second"); // content changed → render output stale
		text.render(20);
		expect(CountingTextComponent.renderCalls).toBe(2);
	});

	it("invalidate() drops the render memo so a same-width frame recomputes (theme change)", () => {
		CountingTextComponent.renderCalls = 0;
		const text = viewportText(CountingTextComponent);
		text.setText("body");
		text.render(20);
		text.render(20); // memo hit
		expect(CountingTextComponent.renderCalls).toBe(1);
		text.invalidate(); // theme/style changed → output stale even at same width
		text.render(20); // must recompute, not serve pre-invalidate output
		expect(CountingTextComponent.renderCalls).toBe(2);
	});

	it("streaming append reuses already-fitted lines and fits only the new tail", () => {
		const text = viewportText(MockTextComponent);
		text.setText("aaaaaaaaaa\nbbbbbbbbbb");
		expect(text.render(5).map(plain)).toEqual(["aaaaa", "bbbbb"]);
		// Append (streaming). Old lines fit identically; new line appears.
		text.setText("aaaaaaaaaa\nbbbbbbbbbb\ncccccccccc");
		expect(text.render(5).map(plain)).toEqual(["aaaaa", "bbbbb", "ccccc"]);
	});

	it("width change re-fits all lines (line cache is width-scoped, no stale serve)", () => {
		const text = viewportText(MockTextComponent);
		text.setText("abcdefghij");
		expect(text.render(5).map(plain)).toEqual(["abcde"]);
		// Must NOT serve the stale 5-wide fit for the same raw line at a new width.
		expect(text.render(8).map(plain)).toEqual(["abcdefgh"]);
	});
});

// Strip ANSI escapes so assertions test content, not color codes.
const ANSI = /\x1b\[[0-9;]*m/g;
function plain(text: string): string {
	return text.replace(ANSI, "");
}

describe("termW", () => {
	// termW() caches and invalidates on a stdout 'resize' event. Set columns then
	// emit resize so the next call re-reads.
	function setCols(cols: number): void {
		(process.stdout as { columns?: number }).columns = cols;
		process.stdout.emit("resize");
	}

	it("returns the true terminal width with no upper clamp (ultrawide)", () => {
		const orig = process.stdout.columns;
		try {
			setCols(384); // wider than the old 210 cap
			expect(termW()).toBe(384);
		} finally {
			setCols(orig ?? 80);
		}
	});

	it("floors width at 1 for a degenerate column count", () => {
		const orig = process.stdout.columns;
		try {
			setCols(0); // falsy — falls through resolution chain, never < 1
			expect(termW()).toBeGreaterThanOrEqual(1);
		} finally {
			setCols(orig ?? 80);
		}
	});
});

describe("frameToolResult", () => {
	it("keeps body unchanged, adds a status-colored close, and forwards invalidation", () => {
		const child = new MockTextComponent();
		child.setText("result");
		const theme: FgTheme = { fg: (key, text) => `[${key}]${text}[/${key}]` };
		const framed = frameToolResult(child, theme, false);

		expect(framed.render(8)).toEqual(["result", "[success]- - - - [/success]"]);
		framed.setText("updated");
		expect(framed.render(8)[0]).toBe("updated");
		framed.invalidate();
		expect(child.invalidations).toBe(1);
	});

	it("unwraps a framed component when a result collapses", () => {
		const child = new MockTextComponent();
		child.setText("expanded");
		const theme: FgTheme = { fg: (key, text) => `[${key}]${text}[/${key}]` };
		const framed = frameToolResult(child, theme, false);
		framed.setText("collapsed");

		expect(unframeToolResult(framed)).toBe(child);
		expect(unframeToolResult(framed).render(20)).toEqual(["collapsed"]);
	});

	it("uses error rules for failed results", () => {
		const child = new MockTextComponent();
		child.setText("failed");
		const theme: FgTheme = { fg: (key, text) => `[${key}]${text}[/${key}]` };

		expect(frameToolResult(child, theme, true).render(4)).toEqual([
			"failed",
			"[error]- - [/error]",
		]);
	});

	it("reuses an existing frame instead of nesting rules on rerender", () => {
		const child = new MockTextComponent();
		child.setText("result");
		const theme: FgTheme = { fg: (key, text) => `[${key}]${text}[/${key}]` };
		const first = frameToolResult(child, theme, false);
		const nextTheme: FgTheme = { fg: (key, text) => `<${key}>${text}</${key}>` };
		const rerendered = frameToolResult(first, nextTheme, true);

		expect(rerendered).toBe(first);
		expect(rerendered.render(4)).toEqual(["result", "<error>- - </error>"]);
	});

	it("keeps solid top and bottom rules for explicit sections", () => {
		const child = new MockTextComponent();
		child.setText("details");
		const theme: FgTheme = { fg: (key, text) => `[${key}]${text}[/${key}]` };

		expect(frameToolSection(child, theme, false).render(4)).toEqual([
			"[success]────[/success]",
			"details",
			"[success]────[/success]",
		]);
	});
});

describe("rule", () => {
	it("renders solid and dashed rules at exact width", () => {
		expect(plain(rule(7))).toBe("───────");
		expect(plain(rule(7, undefined, "dashed"))).toBe("- - - -");
		expect(rule(6, (value) => `<rule>${value}</rule>`, "dashed")).toBe("<rule>- - - </rule>");
	});
});

describe("ruleFrame", () => {
	it("keeps body unchanged and places footer below the dashed close", () => {
		const out = ruleFrame(["a", "b"], ["… +3 more"], 10);
		expect(out).toHaveLength(4);
		expect(out[0]).toBe("a");
		expect(out[1]).toBe("b");
		expect(plain(out[2]!)).toBe("- - - - - ");
		expect(out[3]).toBe("… +3 more");
	});

	it("paints only the close via the supplied status paint", () => {
		const green = (s: string) => `<G>${s}</G>`;
		expect(ruleFrame(["x"], [], 4, green)).toEqual(["x", "<G>- - </G>"]);
	});
});

describe("sectionFrame", () => {
	it("preserves explicit solid top and bottom section rules", () => {
		const out = sectionFrame(["only"], [], 4);
		expect(plain(out[0]!)).toBe("────");
		expect(out[1]).toBe("only");
		expect(plain(out[2]!)).toBe("────");
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

	it("uses dim for the target and muted for tertiary metadata", () => {
		const taggedTheme = {
			fg: (key: string, text: string) => `<${key}>${text}</${key}>`,
			bold: (text: string) => text,
		};
		expect(formatCollapsedToolRow(taggedTheme, "read", "src/a.ts", "12 lines")).toContain(
			"<dim>src/a.ts</dim> <muted>·</muted> <muted>12 lines</muted>",
		);
	});

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

	it("keeps the body first and adds one dashed close", () => {
		const lines = plain(renderDimPreview("a\nb", theme, { frame: true, header: "2 files" })).split(
			"\n",
		);
		expect(lines.slice(0, -1).map((line) => line.trimEnd())).toEqual(["   a", "   b"]);
		expect(lines.at(-1)).toMatch(/^(?:- ){3,}-?$/);
	});

	it("paints the dashed close when a paint fn is given", () => {
		const tag: FgTheme = { fg: (k, v) => `<${k}>${v}` };
		const lines = renderDimPreview("a\nb", tag, {
			frame: true,
			paint: (s: string) => tag.fg("success", s),
		}).split("\n");
		expect(plain(lines.at(-1) ?? "")).toMatch(/^<success>(?:- ){3,}-?/);
	});

	it("puts overflow metadata below the dashed close", () => {
		const body = Array.from({ length: MAX_PREVIEW_LINES + 2 }, (_, i) => `L${i}`);
		const lines = plain(renderDimPreview(body.join("\n"), theme, { frame: true })).split("\n");
		expect(lines.at(-2)).toMatch(/^(?:- ){3,}-?$/);
		expect(lines.at(-1)).toContain("… 2 more lines");
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

	it("highlights every regex match, not just a literal substring", () => {
		// /te.t/ must light up both 'test' and 'text' — a literal indexOf can't.
		const raw = renderDimPreview("test text", theme, { highlight: /te.t/g });
		// Two bold-open codes = two highlighted hits.
		expect(raw.split("\x1b[1m").length - 1).toBe(2);
		expect(plain(raw)).toContain("test text");
	});

	it("does not loop on a zero-width regex match", () => {
		// /x*/ matches empty everywhere — must terminate and keep content intact.
		const raw = renderDimPreview("abc", theme, { highlight: /x*/g });
		expect(plain(raw)).toContain("abc");
	});

	it("skips highlighting a line that already carries ANSI (no escape corruption)", () => {
		// Pre-colored input: a match inside an escape would corrupt it, so the
		// whole line is dimmed instead — no BOLD hit is injected.
		const preColored = "\x1b[31mtest\x1b[0m done";
		const raw = renderDimPreview(preColored, theme, { highlight: "test" });
		expect(raw).not.toContain("\x1b[1m"); // no bold hit
		expect(raw).toContain("\x1b[31m"); // original ANSI preserved
	});

	it("renders an === label === separator as a section divider", () => {
		const raw = renderDimPreview("=== branch ===\nmain", theme, {});
		// Label survives; the raw === markers are gone (replaced by a rule).
		expect(plain(raw)).toContain("branch");
		expect(plain(raw)).not.toContain("===");
		expect(plain(raw)).toContain("─"); // divider glyph
		expect(plain(raw)).toContain("main"); // ordinary lines untouched
	});
});

describe("sectionRule", () => {
	// Tagging theme so we can assert which role each fragment uses.
	const tag: FgTheme = { fg: (key, text) => `<${key}>${text}</${key}>` };

	it("left-aligns the label after a short lead rule, all muted", () => {
		const out = sectionRule("=== versions ===", tag, 40) ?? "";
		expect(out).not.toBeNull();
		// One muted span wrapping the whole divider; label starts after 4 dashes.
		expect(out).toBe("<muted>──── versions ──────────────────────────</muted>");
	});

	it("wraps an over-long label snugly with 2 dashes each side", () => {
		const out = sectionRule("=== a very long section label here ===", tag, 20) ?? "";
		expect(out).toBe("<muted>── a very long section label here ──</muted>");
	});

	it("accepts extra whitespace and 2+ equals signs", () => {
		expect(sectionRule("==  dirty?  ==", tag, 40)).toContain("──── dirty? ");
		expect(sectionRule("===== a b c =====", tag, 40)).toContain("──── a b c ");
	});

	it("returns null for a non-separator line", () => {
		expect(sectionRule("just a normal line", tag, 20)).toBeNull();
		expect(sectionRule("=== no closing", tag, 20)).toBeNull();
		// Must span the whole line — leading text before the === disqualifies it.
		expect(sectionRule("plain === middle === text", tag, 20)).toBeNull();
	});

	it("returns null when the line already carries ANSI", () => {
		expect(sectionRule("\x1b[31m=== x ===\x1b[0m", tag, 20)).toBeNull();
	});

	it("fills the full requested width so it aligns with the tool frame", () => {
		const out = sectionRule("=== x ===", tag, 400) ?? "";
		const visible = out.replace(/<\/?[a-z]+>/g, "");
		expect([...visible].length).toBe(400);
	});
});

describe("bodyLine / moreLines", () => {
	const tag: FgTheme = { fg: (key, text) => `<${key}>${text}</${key}>` };

	it("aligns a body line under the tool title and applies the paint", () => {
		expect(bodyLine("src/a.ts", tag)).toBe(`${BODY_PAD}src/a.ts`);
		expect(bodyLine("src/a.ts", tag, (l) => tag.fg("dim", l))).toBe(
			`${BODY_PAD}<dim>src/a.ts</dim>`,
		);
	});

	it("turns a section line into a full-width muted rule", () => {
		const visible = bodyLine("=== x ===", tag).replace(/<\/?[a-z]+>/g, "");
		expect(visible).toMatch(/^ {3}─{4} x ─+$/);
		expect([...visible].length).toBe(termW());
	});

	it("writes an aligned muted overflow footer", () => {
		expect(moreLines(1, tag)).toBe(`${BODY_PAD}<muted>… 1 more line</muted>`);
		expect(moreLines(3, tag)).toBe(`${BODY_PAD}<muted>… 3 more lines</muted>`);
	});
});

describe("shortPath", () => {
	const home = join("/", "home", "me");
	const cwd = join(home, "repo");

	it("gives a cwd-relative path inside cwd", () => {
		expect(shortPath(cwd, home, join(cwd, "src", "a.ts"))).toBe(join("src", "a.ts"));
	});

	it("shortens home to ~ outside cwd", () => {
		expect(shortPath(cwd, home, join(home, "other", "b.ts"))).toBe(
			`~${join("/", "other", "b.ts")}`,
		);
	});

	it("leaves the path as is when home is empty (HOME unset on Windows)", () => {
		const outside = join("/", "srv", "c.ts");
		expect(shortPath(cwd, "", outside)).toBe(outside);
	});
});
