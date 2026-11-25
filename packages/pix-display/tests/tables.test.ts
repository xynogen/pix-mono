import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, visibleWidth } from "@earendil-works/pi-tui";
import tablesExtension, { styleTable } from "../src/tables.js";

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const theme = {
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
			"┝━━━━━━━━┿━━━━━━┿━━━━━━┥",
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

	it("draws no background, wrapped header lines included", () => {
		const md = `| a b c d e f g h i j k l m n o p q r s t u v w x y z | b |\n|-|-|\n| x | y |\n| z | w |`;
		const lines = render(md, 30);
		const styled = styleTable(lines, [], theme);
		// The long header wrapped; every header line keeps the accent.
		const header = styled.slice(
			1,
			styled.findIndex((line) => plain(line).startsWith("┝")),
		);
		expect(header.length).toBeGreaterThan(1);
		for (const line of header) expect(line).toContain("\x1b[32m");
		for (const line of styled) expect(line).not.toMatch(/\x1b\[4\d/);
	});

	it("ends a tinted badge at the cell edge, so the tint does not bleed into the padding", () => {
		const badge = "\x1b[48;2;30;58;40mtest/long.cpp\x1b[39m\x1b[49m";
		const lines = render(`| File | Isi |\n|-|-|\n| ${badge} | x |\n| a | y |`);
		const row = styleTable(lines, [], theme)[3] ?? "";
		// The slice drops the close on the edge; the reset must restore the background.
		expect(row).toMatch(/long\.cpp\x1b\[[0-9;]*;49m/);
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

	it("a reloaded module replaces the old wrapper around Pi's own renderer", async () => {
		const renderTable = () => Reflect.get(Markdown.prototype, "renderTable");
		const native = Reflect.get(
			Markdown.prototype,
			Symbol.for("@xynogen/pix-display:native-render-table"),
		);
		const reloaded = await import(`../src/tables.ts?reload=${Date.now()}`);
		const before = renderTable();
		// SAFETY: the extension only calls pi.on("session_start", ...), which this stub covers.
		reloaded.default({ on: () => undefined } as unknown as ExtensionAPI);
		expect(renderTable()).not.toBe(before);
		expect(
			Reflect.get(Markdown.prototype, Symbol.for("@xynogen/pix-display:native-render-table")),
		).toBe(native);
	});
});
