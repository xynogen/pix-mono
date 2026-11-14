import { afterEach, describe, expect, it } from "bun:test";

import { join } from "node:path";
import { getCapabilities, setCapabilities, visibleWidth } from "@earendil-works/pi-tui";
import type { FgTheme } from "../src/types.ts";
import {
	fillToolBackground,
	formatJson,
	linkedShortPath,
	shortPath,
	terminalWidth,
	viewportText,
} from "../src/utils.ts";

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

const ANSI = /\x1b\[[0-9;]*m/g;

function plain(text: string): string {
	return text.replace(ANSI, "");
}

const _theme: FgTheme = { fg: (_key, text) => text };

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

describe("terminalWidth", () => {
	// terminalWidth() caches and invalidates on a stdout 'resize' event. Set columns then
	// emit resize so the next call re-reads.
	function setCols(cols: number): void {
		(process.stdout as { columns?: number }).columns = cols;
		process.stdout.emit("resize");
	}

	it("returns the true terminal width with no upper clamp (ultrawide)", () => {
		const orig = process.stdout.columns;
		try {
			setCols(384); // wider than the old 210 cap
			expect(terminalWidth()).toBe(384);
		} finally {
			setCols(orig ?? 80);
		}
	});

	it("floors width at 1 for a degenerate column count", () => {
		const orig = process.stdout.columns;
		try {
			setCols(0); // falsy — falls through resolution chain, never < 1
			expect(terminalWidth()).toBeGreaterThanOrEqual(1);
		} finally {
			setCols(orig ?? 80);
		}
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

describe("linkedShortPath", () => {
	const cwd = join("/", "home", "me", "repo");
	const caps = getCapabilities();
	afterEach(() => setCapabilities(caps));

	it("wraps the short path in an OSC 8 file link when the terminal supports links", () => {
		setCapabilities({ ...caps, hyperlinks: true });
		const out = linkedShortPath(cwd, "", join(cwd, "src", "a b.ts"));
		expect(out).toMatch(
			/^\x1b\]8;;file:\/\/\/[^\x1b]*\/repo\/src\/a%20b\.ts\x1b\\src[\\/]a b\.ts\x1b\]8;;\x1b\\$/,
		);
		expect(visibleWidth(out)).toBe(join("src", "a b.ts").length);
	});

	it("returns plain shortPath text when links are unsupported", () => {
		setCapabilities({ ...caps, hyperlinks: false });
		expect(linkedShortPath(cwd, "", join(cwd, "a.ts"))).toBe("a.ts");
	});
});
