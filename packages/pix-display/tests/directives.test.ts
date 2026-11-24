import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	resetCapabilitiesCache,
	setCapabilities,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { BOLD, FG_BLUE, FG_GREEN, FG_RED } from "@xynogen/pix-pretty/ansi";
import { renderDirectives } from "../src/directives.js";

// Card bodies render with Pi's Markdown theme, which Pi initialises at startup.
beforeAll(() => initTheme("dark"));
afterEach(() => resetCapabilitiesCache());

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
	it("renders consecutive one-line cards side by side", () => {
		const lines = render(
			'Ringkasan\n::card[23]{label="Total entri"}\n::card[4]{label="Provider_ns *x*"}\n\nLanjut',
			40,
		);
		expect(lines.filter(Boolean)).toEqual([
			"Ringkasan",
			"╭─────────────────╮ ╭─────────────────╮",
			"│ Total entri     │ │ Provider_ns *x* │",
			"│ 23              │ │ 4               │",
			"╰─────────────────╯ ╰─────────────────╯",
			"Lanjut",
		]);
	});

	it("wraps cards to the width and pads a row to its tallest card", () => {
		const md = ["a", "b", "c"].map((v) => `::card[${v}]{label=x}`).join("\n");
		const lines = render(md, 34).filter(Boolean);
		expect(lines).toHaveLength(8);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(34);
		const uneven = render("::card[1]{label=x}\n::card[2]", 40).filter(Boolean);
		expect(uneven[2]).toBe("│ 1               │ │                 │");
	});

	it("makes a card with a subtitle or body lines a full-width card", () => {
		const md =
			'::card[Nullius in verba]{subtitle="Take nobody\'s word for it."}\nVerify it through **evidence**.\n- one\n- `two`\n\nafter';
		const lines = render(md, 30).filter(Boolean);
		expect(lines).toEqual([
			`╭${"─".repeat(28)}╮`,
			"│ Nullius in verba           │",
			"│ Take nobody's word for it. │",
			"│                            │",
			"│ Verify it through          │",
			"│ evidence.                  │",
			"│ - one                      │",
			"│ - two                      │",
			`╰${"─".repeat(28)}╯`,
			"after",
		]);
		// Small cards stay side by side; a full card between them takes its own row.
		const mixed = render("::card[1]\n::card[2]\n::card[T]\nbody\n::card[3]", 40).filter(Boolean);
		expect(mixed.filter((l) => l.startsWith("╭")).map((l) => l.split("╮").length - 1)).toEqual([
			2, 1, 1,
		]);
		// A fence in the body stays whole, blank lines included.
		const fenced = render("::card[T]\n```\na\n\n::card[x]\n```\nafter", 30).join("\n");
		expect(fenced).toContain("::card[x]");
		expect(fenced).not.toContain("after\n");
	});

	it("keeps directives in code fences and inline text literal", () => {
		const md = "```\n::card[1]{label=x}\n:red[a]\n```\nsee ::card[2] here, `:red[b]`, a::red[c]";
		expect(renderDirectives(md, 40)).toBe(md);
	});

	it("colors inline text and keeps surrounding emphasis", () => {
		const md = "Status: :red[**gagal**] lalu **:green[lulus] semua**";
		const out = renderDirectives(md, 40);
		expect(out).toBe(`Status: ${FG_RED}**gagal**\x1b[39m lalu **${FG_GREEN}lulus\x1b[39m semua**`);
		expect(render(md, 60)[0]).toBe("Status: gagal lalu lulus semua");
	});

	it("renders consecutive bars as one chart with an x axis from 0 to max", () => {
		const md = '::bar[100]{label="a (x)"}\n::bar[50]{label="bb"}\n::bar[0]{label="c"}';
		const lines = render(md, 30).filter(Boolean);
		expect(lines).toHaveLength(5);
		const full = lines[0]?.match(/█+/)?.[0].length ?? 0;
		expect(lines[0]).toStartWith("a (x)│█");
		expect(lines[0]).toEndWith(" 100");
		expect(lines[1]?.match(/█+/)?.[0].length).toBe(full / 2);
		expect(lines[2]).toBe("c    │ 0");
		expect(lines[3]).toStartWith("     └┬");
		expect(lines[3]?.match(/┬/g)).toHaveLength(3);
		expect(lines[4]?.trim().split(/\s+/)).toEqual(["0", "50", "100"]);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
	});

	it("leaves a bar or sparkline with invalid values as text", () => {
		for (const md of ["::bar[abc]", ":spark[5]", ":spark[1 x]"]) {
			expect(renderDirectives(md, 40)).toBe(md);
		}
	});

	it("renders an inline sparkline scaled from min to max", () => {
		expect(render("Build :spark[1, 4, 2, 8, 5] naik", 40)[0]).toBe("Build ▁▄▂█▅ naik");
		expect(render("Flat :spark[3 3 3]", 40)[0]).toBe("Flat ▄▄▄");
		expect(renderDirectives("`:spark[1 2]`", 40)).toBe("`:spark[1 2]`");
	});

	it("renders a padded badge on a tinted background, blue by default", () => {
		expect(render("**Langkah** :badge[Tahap 1] mulai", 40)[0]).toBe("Langkah  Tahap 1  mulai");
		const out = renderDirectives(":badge[ok]{color=green} :badge[x]{color=pink}", 40);
		expect(out).toContain(`${FG_GREEN}\u00a0ok\u00a0\x1b[39m\x1b[49m`);
		expect(out).toContain(`${FG_BLUE}\u00a0x\u00a0`);
		expect(renderDirectives("`:badge[a]`", 40)).toBe("`:badge[a]`");
	});

	it("turns links, bare URLs and file paths into badges, links kept clickable", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		// What the terminal gets: OSC 8 kept as `<a url>` markers, all other escapes dropped.
		const links = (md: string) =>
			new Markdown(renderDirectives(md, 80), 0, 0, theme)
				.render(80)[0]
				?.replace(/\x1b\]8;;([^\x07]*)\x07/g, (_, url: string) => (url ? `<a ${url}>` : "</a>"))
				.replace(ANSI_RE, "")
				.replaceAll("\u00a0", " ")
				.trimEnd();
		expect(links("See [the docs](https://pi.dev/x) or https://www.github.com/a/b.")).toBe(
			"See <a https://pi.dev/x> the docs </a> or <a https://www.github.com/a/b> github.com </a>.",
		);
		expect(render("Edit src/a.ts:12 or `pkg/b.md`, not `npm i`.", 80)[0]).toBe(
			"Edit  src/a.ts:12  or  pkg/b.md , not npm i.",
		);
		const plain = "3/4 and/or TCP/IP v1.2 e.g. ![x](https://i.png)";
		expect(renderDirectives(plain, 80)).toBe(plain);
		const fenced = "```\nhttps://a.b/c src/a.ts\n```";
		expect(renderDirectives(fenced, 80)).toBe(fenced);
		// Without OSC 8 a badge would hide the URL: Pi's own link rendering stays.
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		expect(renderDirectives("[d](https://pi.dev) https://x.y/z", 80)).toBe(
			"[d](https://pi.dev) https://x.y/z",
		);
	});

	it("renders inline directives inside a table without breaking its columns", () => {
		const md = "| A | B |\n|---|---|\n| x | :red[gagal] |\n| y | :spark[1 3 2] |";
		const lines = render(md, 40).filter(Boolean);
		expect(lines[3]).toBe("│ x │ gagal │");
		expect(lines[5]).toBe("│ y │ ▁█▅   │");
		const widths = new Set(lines.map((line) => visibleWidth(line)));
		expect(widths.size).toBe(1);
	});

	it("colors the value or bar with color= and ignores unknown colors", () => {
		const stat = renderDirectives("::card[3]{label=x color=red}", 40);
		expect(stat).toContain(`${BOLD}${FG_RED}3`);
		const bars = renderDirectives(
			'::bar[3]{label=a color=green}\n::bar[5]{label=b color="pink"}',
			40,
		);
		expect(bars).toContain(`${FG_GREEN}█`);
		expect(bars).toContain(`${FG_BLUE}█`);
	});

	it("draws vertical bars with direction=vertical and falls back when too narrow", () => {
		const md = '::bar[8]{label="a" direction=vertical height=4}\n::bar[2]{label="bb"}';
		const lines = render(md, 40).filter(Boolean);
		expect(lines).toEqual(["  8", "8┤██", " │██", "4┤██ 2", " │██ ██", "0└─────", "  a  bb"]);
		// Five 4-digit values need 5 × 5 columns; 16 columns forces the horizontal fallback.
		const wide = [1000, 2000, 3000, 4000, 5000]
			.map((v, i) => `::bar[${v}]{label="x"${i === 0 ? " direction=vertical" : ""}}`)
			.join("\n");
		const narrow = render(wide, 16).filter(Boolean);
		expect(narrow).toHaveLength(7);
		expect(narrow[0]).toStartWith("x│█");
	});

	it("renders consecutive stacked lines as one 100% bar over a legend", () => {
		const md =
			'::stacked[30]{label="a"}\n::stacked[10]{label="bb" color=red}\n::stacked[0]{label="c"}';
		const lines = render(md, 40).filter(Boolean);
		expect(lines).toEqual([
			`${"█".repeat(30)}${"▓".repeat(10)}`,
			"● a  30 75%",
			"● bb 10 25%",
			"● c   0 0%",
		]);
		const out = renderDirectives(md, 40);
		expect(out).toContain(`${FG_BLUE}█`);
		expect(out).toContain(`${FG_RED}▓`);
		expect(out).toContain(`${FG_RED}●`);
		for (const bad of ["::stacked[-1]", "::stacked[x]"])
			expect(renderDirectives(bad, 40)).toBe(bad);
	});
});
