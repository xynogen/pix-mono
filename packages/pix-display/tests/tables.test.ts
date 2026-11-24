import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, visibleWidth } from "@earendil-works/pi-tui";
import tablesExtension, { styleTable } from "../src/tables.js";

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const theme = {
	bg: (color: string, text: string) =>
		`\x1b[4${color === "selectedBg" ? "1" : "2"}m${text}\x1b[49m`,
	bold: (text: string) => text,
	fg: (color: string, text: string) => `\x1b[3${color === "accent" ? "2" : "8"}m${text}\x1b[39m`,
};
const mdTheme = {
	heading: (t: string) => t,
	link: (t: string) => t,
	linkUrl: (t: string) => t,
	code: (t: string) => t,
	codeBlock: (t: string) => t,
	codeBlockBorder: (t: string) => t,
	quote: (t: string) => t,
	quoteBorder: (t: string) => t,
	hr: (t: string) => t,
	listBullet: (t: string) => t,
	bold: (t: string) => `\x1b[1m${t}\x1b[22m`,
	italic: (t: string) => t,
	strikethrough: (t: string) => t,
	underline: (t: string) => t,
};

const plain = (line: string) => line.replace(ANSI_RE, "");
const TABLE =
	"| Name | Qty | Note |\n|:-----|----:|:----:|\n| pix | 7 | ok |\n| **pretty** | 1200 | x |";

// Markdown pads rows to the full width; renderTable itself returns them unpadded.
function render(markdown: string, width = 60): string[] {
	return new Markdown(markdown, 0, 0, mdTheme).render(width).map((line) => line.trimEnd());
}

describe("styleTable", () => {
	it("rounds corners and honours column alignment", () => {
		const lines = render(TABLE);
		const styled = styleTable(lines, ["left", "right", "center"], theme).map(plain);
		expect(styled).toEqual([
			"╭────────┬──────┬──────╮",
			"│ Name   │  Qty │ Note │",
			"├────────┼──────┼──────┤",
			"│ pix    │    7 │  ok  │",
			"├────────┼──────┼──────┤",
			"│ pretty │ 1200 │  x   │",
			"╰────────┴──────┴──────╯",
		]);
	});

	it("colours borders and header, keeping row widths", () => {
		const lines = render(TABLE);
		const styled = styleTable(lines, [], theme);
		expect(styled[0]).toStartWith("\x1b[38m╭");
		expect(styled[1]).toContain("\x1b[32m");
		expect(styled[3]).not.toContain("\x1b[32m");
		for (const [i, line] of styled.entries()) {
			expect(visibleWidth(line)).toBe(visibleWidth(lines[i] ?? ""));
		}
	});

	it("shades the header and every second body row, wrapped lines included", () => {
		const md = `${TABLE}\n| third | 3 | a b c d e f g h i j k l m n o p q r s t u v w x y z |`;
		const lines = render(md, 30);
		const styled = styleTable(lines, [], theme);
		const shade = (line: string) => line.match(/^\x1b\[4(\d)m/)?.[1];
		let row = -1;
		for (const [i, line] of lines.entries()) {
			if (line.startsWith("├")) row++;
			if (!line.startsWith("│")) {
				expect(shade(styled[i] ?? "")).toBeUndefined();
				continue;
			}
			const expected = row < 0 ? "1" : row % 2 === 1 ? "2" : undefined;
			expect(shade(styled[i] ?? "")).toBe(expected);
		}
		// More text rows than header + 3 rows: the long cell wrapped.
		expect(lines.filter((line) => line.startsWith("│")).length).toBeGreaterThan(4);
	});

	it("keeps Pi's raw fallback for a table too narrow to draw", () => {
		const lines = render(TABLE, 8);
		expect(styleTable(lines, [], theme)).toEqual(lines);
	});
});

describe("tablesExtension", () => {
	it("patches Markdown tables once the TUI session starts", () => {
		let start: ((event: object, ctx: object) => void) | undefined;
		const pi = {
			on: (_event: string, handler: typeof start) => {
				start = handler;
			},
		};
		// SAFETY: the extension only calls pi.on("session_start", ...), which this stub covers.
		tablesExtension(pi as unknown as ExtensionAPI);
		start?.({}, { mode: "tui", ui: { theme } });
		expect(plain(render(TABLE)[0] ?? "")).toStartWith("╭");
	});
});
