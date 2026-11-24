import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import { hasDisplayMath, renderMath, renderMathBlocks, startMath } from "../src/math.js";

/** Columns and rows Pi's Image asked the terminal to draw. */
function size(rows: readonly string[] | undefined): { cols: number; rows: number } | undefined {
	const seq = rows?.find((row) => row.includes("\x1b_G")) ?? "";
	const cols = Number(/c=(\d+)/.exec(seq)?.[1]);
	const height = Number(/r=(\d+)/.exec(seq)?.[1]);
	return cols > 0 ? { cols, rows: height } : undefined;
}

beforeAll(() => startMath());
afterEach(() => resetCapabilitiesCache());

describe("display math", () => {
	it("draws a formula at text size, not the screen width", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		const fraction = size(renderMath("Q = \\frac{T_{die} - T_{ambient}}{R_{total}}", 120));
		expect(fraction?.rows).toBe(2);
		expect(fraction?.cols).toBeLessThan(30);
		expect(size(renderMath("a + b", 120))?.rows).toBe(1);
	});

	it("frames the image in a dim box as wide as the drawn image", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		const rows = renderMath("a + b", 120) ?? [];
		const cols = size(rows)?.cols ?? 0;
		expect(rows[0]).toContain(`╭${"─".repeat(cols + 4)}╮`);
		expect(rows.at(-1)).toContain(`╰${"─".repeat(cols + 4)}╯`);
		// A padding row, then the image row, both jumping over the image to the right border.
		expect(rows[1]).not.toContain("\x1b_G");
		expect(rows[1]).toContain(`\x1b[${cols}C`);
		expect(rows[2]).toContain("\x1b_G");
		expect(rows).toHaveLength(5);
		// Too narrow for the frame: the bare image.
		const bare = renderMath("a + b", cols + 5) ?? [];
		expect(bare[0]).toContain("\x1b_G");
	});

	it("keeps Pi's Unicode rendering for TeX errors, no image support, or too wide", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		expect(renderMath("\\frac{a}{b", 80)).toBeUndefined();
		expect(renderMath("a + b + c + d + e + f + g + h", 4)).toBeUndefined();
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		expect(renderMath("a + b", 80)).toBeUndefined();
	});

	it("replaces $$ and \\[ blocks, and leaves inline math and code fences alone", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
		const out = renderMathBlocks("a\n$$\nx^2\n$$\nb \\[y\\] $z$\n\\[w\\]", 80);
		const images = out.split("\n").filter((line) => line.includes("\x1b_G"));
		expect(images).toHaveLength(2);
		expect(out).toContain("b \\[y\\] $z$");
		expect(out).not.toContain("$$");
		const fenced = "```\n$$x$$\n```";
		expect(renderMathBlocks(fenced, 80)).toBe(fenced);
	});

	it("finds display math only in assistant text, as the install trigger", () => {
		const reply = (text: string, role = "assistant") => ({
			role,
			content: [{ type: "text", text }],
		});
		expect(hasDisplayMath([reply("a\n$$x^2$$")])).toBe(true);
		expect(hasDisplayMath([reply("\\[x\\]")])).toBe(true);
		expect(hasDisplayMath([reply("inline $x$ and $5")])).toBe(false);
		expect(hasDisplayMath([reply("$$x$$", "user")])).toBe(false);
	});
});
