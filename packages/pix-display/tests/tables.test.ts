import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Component, Markdown, visibleWidth } from "@earendil-works/pi-tui";
import { nativeMethodKey } from "@xynogen/pix-runtime/patch";
import tablesExtension, {
	cellNumber,
	columnAt,
	isNumericColumn,
	sortRows,
	styleTable,
} from "../src/tables.js";

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
		const native = Reflect.get(Markdown.prototype, nativeMethodKey("renderTable"));
		const reloaded = await import(`../src/tables.ts?reload=${Date.now()}`);
		const before = renderTable();
		// SAFETY: the extension only calls pi.on("session_start", ...), which this stub covers.
		reloaded.default({ on: () => undefined } as unknown as ExtensionAPI);
		expect(renderTable()).not.toBe(before);
		expect(Reflect.get(Markdown.prototype, nativeMethodKey("renderTable"))).toBe(native);
	});
});

describe("table sort", () => {
	const cell = (text: string) => ({ text });
	const rows = [
		["b", "3,781"],
		["A10", "22"],
		["a2", ""],
		["c", "-1.5"],
	].map((r) => r.map(cell));
	const col = (sorted: { text: string }[][], i: number) => sorted.map((r) => r[i]?.text);

	it("reads numbers with commas, units and markup, not versions", () => {
		expect(["3,781", "84.26%", "12 ms", "**7**", "-2"].map(cellNumber)).toEqual([
			3781, 84.26, 12, 7, -2,
		]);
		expect(cellNumber("0.8.0")).toBeUndefined();
		expect(isNumericColumn(rows, 1)).toBe(true);
		expect(isNumericColumn(rows, 0)).toBe(false);
	});

	it("sorts numbers by value and text A-Z with natural digits, empty cells last", () => {
		expect(col(sortRows(rows, 1, true, true), 1)).toEqual(["3,781", "22", "-1.5", ""]);
		expect(col(sortRows(rows, 1, false, true), 1)).toEqual(["-1.5", "22", "3,781", ""]);
		expect(col(sortRows(rows, 0, false, false), 0)).toEqual(["a2", "A10", "b", "c"]);
		expect(col(sortRows(rows, 0, true, false), 0)).toEqual(["c", "b", "A10", "a2"]);
	});

	it("maps a click x to its column, borders and padding included", () => {
		// " │ Name │ Qty │": borders at 1, 8, 14. Column 0 is x 1..7, column 1 is x 8..14.
		const row = " │ Name │ Qty │";
		expect([0, 1, 7, 8, 14, 15].map((x) => columnAt(row, x))).toEqual([
			undefined,
			0,
			0,
			1,
			1,
			undefined,
		]);
		// Wide characters count two columns; rules and top borders map the same way.
		expect(columnAt("│ 名前 │ x │", 7)).toBe(1);
		expect(columnAt("╭──────┬─────╮", 3)).toBe(0);
	});

	const click = (md: Component, x: number, y: number) =>
		md.handleMouse?.({
			type: "click",
			button: "left",
			x,
			y,
			width: 40,
			height: 20,
			screenX: x,
			screenY: y,
			shift: false,
			alt: false,
			ctrl: false,
		});
	const linesOf = (md: Component) => md.render(40).map(plain);
	const body = (md: Component) =>
		linesOf(md)
			.filter((l) => /^ ?│ [abc] /.test(l))
			.map((l) => l.trim().slice(2, 3));
	const rowOf = (md: Component, text: string) => linesOf(md).findIndex((l) => l.includes(text));

	it("a header click sorts the rendered table, a second click reverses it", () => {
		const md: Component = new Markdown(
			"| Pkg | Tests |\n|---|--:|\n| b | 22 |\n| a | 3,781 |\n| c | 5 |",
			0,
			0,
			mdTheme,
		);
		const header = rowOf(md, "Pkg");
		expect(linesOf(md)[header]).toContain("▾ Pkg");
		expect(linesOf(md)[header]).toContain("▾ Tests");
		expect(body(md)).toEqual(["b", "a", "c"]);
		expect(click(md, 8, header)).toEqual({ handled: true });
		expect(body(md)).toEqual(["a", "b", "c"]);
		expect(linesOf(md)[header]).toContain("▼ Tests");
		expect(linesOf(md)[header]).toContain("▾ Pkg");
		click(md, 8, header);
		expect(body(md)).toEqual(["c", "b", "a"]);
		click(md, 2, header);
		expect(body(md)).toEqual(["a", "b", "c"]);
		expect(linesOf(md)[header]).toContain("▲ Pkg");
		expect(linesOf(md)[header]).toContain("▾ Tests");
	});

	it("hits the whole header block with padding, and only the clicked table", () => {
		// Sort state is keyed by table source: give each table its own.
		const table = (name: string) =>
			`| ${name} | Tests |\n|---|--:|\n| b | 22 |\n| a | 3,781 |\n| c | 5 |`;
		const md: Component = new Markdown(
			`${table("One")}\n\nMiddle\n\n${table("Two")}`,
			1,
			0,
			mdTheme,
		);
		const tops = linesOf(md).flatMap((l, i) => (l.trim().startsWith("┌") ? [i] : []));
		const [first = 0, second = 0] = tops;
		// Top border of the second table, on "┬": the left border of column 1 (Tests, large first).
		const x = linesOf(md)[second]?.indexOf("┬") ?? -1;
		expect(click(md, x, second)).toEqual({ handled: true });
		expect(linesOf(md).find((l) => l.includes("Two"))).toContain("▼ Tests");
		// Only the second table: a 3,781 · b 22 · c 5.
		expect(body(md)).toEqual(["b", "a", "c", "a", "b", "c"]);
		// The rule under the header also counts; a body row does not.
		expect(click(md, 3, first + 2)).toEqual({ handled: true });
		expect(body(md).slice(0, 3)).toEqual(["a", "b", "c"]);
		expect(click(md, 3, first + 3)).toBeUndefined();
	});
});
