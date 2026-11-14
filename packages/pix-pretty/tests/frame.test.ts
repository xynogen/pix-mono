import { describe, expect, it } from "bun:test";
import { type Color, colorToRgb, rgbColor, Text } from "@earendil-works/pi-tui";
import {
	BODY_PAD,
	bodyLine,
	fadeRulePaint,
	frameToolResult,
	frameToolSection,
	moreLines,
	reuseText,
	rule,
	ruleFrame,
	sectionFrame,
	sectionRule,
	unframeToolResult,
} from "../src/frame.ts";
import type { FgTheme } from "../src/types.ts";
import { terminalWidth } from "../src/utils.ts";

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

const ANSI = /\x1b\[[0-9;]*m/g;

function plain(text: string): string {
	return text.replace(ANSI, "");
}

const _theme: FgTheme = { fg: (_key, text) => text };

describe("frameToolResult", () => {
	it("keeps body unchanged, adds a status-colored close, and forwards invalidation", () => {
		const child = new MockTextComponent();
		child.setText("result");
		const theme: FgTheme = { fg: (key, text) => `[${key}]${text}[/${key}]` };
		const framed = frameToolResult(child, theme, false);

		expect(framed.render(8)).toEqual(["result", "[success]────────[/success]"]);
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

	it("reuseText keeps the prior text component and replaces anything else", () => {
		const child = new MockTextComponent();
		const theme: FgTheme = { fg: (_key, text) => text };
		expect(reuseText(frameToolResult(child, theme, false))).toBe(child);
		expect(reuseText(child)).toBe(child);
		const plain = { render: () => [], invalidate: () => {} };
		expect(reuseText(plain)).toBeInstanceOf(Text);
		expect(reuseText(undefined)).toBeInstanceOf(Text);
	});

	it("uses error rules for failed results", () => {
		const child = new MockTextComponent();
		child.setText("failed");
		const theme: FgTheme = { fg: (key, text) => `[${key}]${text}[/${key}]` };

		expect(frameToolResult(child, theme, true).render(4)).toEqual([
			"failed",
			"[error]────[/error]",
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
		expect(rerendered.render(4)).toEqual(["result", "<error>────</error>"]);
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
	it("renders a solid rule at exact width", () => {
		expect(plain(rule(7))).toBe("───────");
		expect(rule(6, (value) => `<rule>${value}</rule>`)).toBe("<rule>──────</rule>");
	});
});

describe("fadeRulePaint", () => {
	const green = rgbColor(0, 200, 0);
	const bg = rgbColor(0, 0, 0);
	const cells: number[] = [];
	const theme = {
		fg: (_k: "success" | "error", s: string) => `[flat:${s.length}]`,
		colors: { success: green, error: green, toolSuccessBg: bg, toolErrorBg: bg },
		style: (s: string, o: { fg: Color }) => {
			cells.push(colorToRgb(o.fg).g);
			return s;
		},
	};

	it("fades both ends toward the background and keeps the middle flat", () => {
		const out = fadeRulePaint(theme, "success", 3)("─".repeat(10));
		expect(out).toBe("───[flat:4]───");
		const [l0 = 0, l1 = 0, l2 = 0, r0 = 0, r1 = 0, r2 = 0] = cells;
		// Left rises toward full color, right falls back, mirrored.
		expect(l0).toBeLessThan(l1);
		expect(l1).toBeLessThan(l2);
		expect(l2).toBeLessThan(200);
		expect([r0, r1, r2]).toEqual([l2, l1, l0]);
	});

	it("stays a flat theme.fg rule without color data", () => {
		expect(fadeRulePaint({ fg: theme.fg }, "error")("────")).toBe("[flat:4]");
	});
});

describe("ruleFrame", () => {
	it("keeps body unchanged and places footer below the solid close", () => {
		const out = ruleFrame(["a", "b"], ["… +3 more"], 10);
		expect(out).toHaveLength(4);
		expect(out[0]).toBe("a");
		expect(out[1]).toBe("b");
		expect(plain(out[2]!)).toBe("──────────");
		expect(out[3]).toBe("… +3 more");
	});

	it("paints only the close via the supplied status paint", () => {
		const green = (s: string) => `<G>${s}</G>`;
		expect(ruleFrame(["x"], [], 4, green)).toEqual(["x", "<G>────</G>"]);
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
		expect(visible).toMatch(/^\t─{4} x ─+$/);
		expect([...visible].length).toBe(terminalWidth() - 2); // 1 tab char = 3 cells
	});

	it("writes an aligned muted overflow footer with the expand hint", () => {
		// Shape: `<pad>… N more line(s) (<key> to expand)`; the key comes from the host.
		const plain = (s: string) => s.replace(/<\/?[a-z]+>/g, "");
		expect(plain(moreLines(1, tag))).toBe(`${BODY_PAD}… 1 more line (ctrl+o to expand)`);
		expect(plain(moreLines(3, tag))).toBe(`${BODY_PAD}… 3 more lines (ctrl+o to expand)`);
		const keyHint = (_id: string, text: string) => `alt+x ${text}`;
		expect(plain(moreLines(2, tag, { keyHint }))).toBe(
			`${BODY_PAD}… 2 more lines (alt+x to expand)`,
		);
	});
});
