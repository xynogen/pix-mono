import { describe, expect, it } from "bun:test";
import { Markdown, visibleWidth } from "@earendil-works/pi-tui";
import { BOLD, FG_BLUE, FG_GREEN, FG_RED, FG_YELLOW } from "@xynogen/pix-pretty/ansi";
import { renderDirectives } from "../src/directives.js";

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const identity = (text: string) => text;
// SAFETY: every MarkdownTheme member is a string styler; identity keeps text plain.
const theme = new Proxy({}, { get: () => identity }) as ConstructorParameters<typeof Markdown>[3];

function render(markdown: string, width: number): string[] {
	return new Markdown(renderDirectives(markdown, width), 0, 0, theme)
		.render(width)
		.map((line) => line.replace(ANSI_RE, "").replaceAll("\u00a0", " ").trimEnd());
}

describe("renderDirectives", () => {
	it("renders consecutive stats as one row of cards", () => {
		const lines = render(
			'Ringkasan\n::stat[23]{label="Total entri"}\n::stat[4]{label="Provider_ns *x*"}\nLanjut',
			40,
		);
		expect(lines.filter(Boolean)).toEqual([
			"Ringkasan",
			"╭─────────────────╮ ╭─────────────────╮",
			"│ 23              │ │ 4               │",
			"│ Total entri     │ │ Provider_ns *x* │",
			"╰─────────────────╯ ╰─────────────────╯",
			"Lanjut",
		]);
	});

	it("wraps cards to the width", () => {
		const md = ["a", "b", "c"].map((v) => `::stat[${v}]{label=x}`).join("\n");
		const lines = render(md, 34).filter(Boolean);
		expect(lines).toHaveLength(8);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(34);
	});

	it("keeps directives in code fences and inline text literal", () => {
		const md = "```\n::stat[1]{label=x}\n:red[a]\n```\nsee ::stat[2] here, `:red[b]`, a::red[c]";
		expect(renderDirectives(md, 40)).toBe(md);
	});

	it("colors inline text and keeps surrounding emphasis", () => {
		const md = "Status: :red[**gagal**] lalu **:green[lulus] semua**";
		const out = renderDirectives(md, 40);
		expect(out).toBe(`Status: ${FG_RED}**gagal**\x1b[39m lalu **${FG_GREEN}lulus\x1b[39m semua**`);
		expect(render(md, 60)[0]).toBe("Status: gagal lalu lulus semua");
	});

	it("renders consecutive bars as one chart scaled to the largest value", () => {
		const md = '::bar[100]{label="a (x)"}\n::bar[50]{label="bb"}\n::bar[0]{label="c"}';
		const lines = render(md, 30).filter(Boolean);
		expect(lines).toHaveLength(3);
		const full = lines[0]?.match(/█+/)?.[0].length ?? 0;
		expect(lines[0]).toStartWith("a (x) █");
		expect(lines[0]).toEndWith(" 100");
		expect(lines[1]?.match(/█+/)?.[0].length).toBe(full / 2);
		expect(lines[2]).toBe("c      0");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
	});

	it("renders a braille line chart with min and max ticks", () => {
		const lines = render('::chart[1 3 2]{label="Build (s)" height=3}', 40).filter(Boolean);
		expect(lines[0]).toBe("Build (s)");
		expect(lines[1]).toStartWith("3┤");
		expect(lines[3]).toStartWith("1┤");
		expect(lines[4]).toStartWith(" └─");
		expect(lines.slice(1, 4).join("")).toMatch(/[\u2801-\u28ff]/);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
	});

	it("leaves a chart with too few or invalid values as text", () => {
		for (const md of ["::chart[5]", "::chart[1 x 3]", "::bar[abc]", ":spark[5]", ":spark[1 x]"]) {
			expect(renderDirectives(md, 40)).toBe(md);
		}
	});

	it("renders an inline sparkline scaled from min to max", () => {
		expect(render("Build :spark[1, 4, 2, 8, 5] naik", 40)[0]).toBe("Build ▁▄▂█▅ naik");
		expect(render("Flat :spark[3 3 3]", 40)[0]).toBe("Flat ▄▄▄");
		expect(renderDirectives("`:spark[1 2]`", 40)).toBe("`:spark[1 2]`");
	});

	it("renders inline directives inside a table without breaking its columns", () => {
		const md = "| A | B |\n|---|---|\n| x | :red[gagal] |\n| y | :spark[1 3 2] |";
		const lines = render(md, 40).filter(Boolean);
		expect(lines[3]).toBe("│ x │ gagal │");
		expect(lines[5]).toBe("│ y │ ▁█▅   │");
		const widths = new Set(lines.map((line) => visibleWidth(line)));
		expect(widths.size).toBe(1);
	});

	it("colors the value, bar or line with color= and ignores unknown colors", () => {
		const stat = renderDirectives("::stat[3]{label=x color=red}", 40);
		expect(stat).toContain(`${BOLD}${FG_RED}3`);
		const bars = renderDirectives(
			'::bar[3]{label=a color=green}\n::bar[5]{label=b color="pink"}',
			40,
		);
		expect(bars).toContain(`${FG_GREEN}█`);
		expect(bars).toContain(`${FG_BLUE}█`);
		expect(renderDirectives("::chart[1 2 3]{color=yellow}", 40)).toContain(FG_YELLOW);
	});
});
