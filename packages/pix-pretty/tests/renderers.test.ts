import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderFileContent } from "../src/renderers.ts";

test("expanded file rendering wraps long lines without hiding their tail", async () => {
	const tail = "TAIL_MUST_REMAIN_VISIBLE";
	const rendered = await renderFileContent(
		`const value = "${"x".repeat(80)}${tail}";`,
		"sample.ts",
		1,
		1,
		undefined,
		{ width: 32, wrapLongLines: true },
	);
	const lines = rendered.split("\n");
	const plainJoined = rendered.replace(/\u001b\[[0-9;]*m/g, "").replace(/\n\s*\u2502 /g, "");

	// No tail lost: the whole line survives once continuation rows are rejoined.
	expect(plainJoined).toContain(tail);
	// Every rendered row stays within the requested width (wrapped, not overflowing).
	expect(lines.every((line) => visibleWidth(line) <= 32)).toBe(true);
});

test("cut preview fades the code only, never the line-number gutter", async () => {
	const theme = { fg: (_k: string, t: string) => t, bg: (_k: string, t: string) => t };
	const src = Array.from({ length: 30 }, (_, i) => `const x${i} = ${i};`).join("\n");
	const rows = (await renderFileContent(src, "a.ts", 1, 8, theme, { width: 60 })).split("\n");
	// Gutter = styling up to and including the rule; the line number itself is masked.
	const gutter = (row: string) => row.slice(0, row.indexOf("\u2502") + 1).replace(/m +\d+/, "m N");
	// Rows 1–8 sit between the top rule and the bottom rule; 6–8 are faded.
	const first = gutter(rows[1]!);
	for (const row of rows.slice(2, 9)) expect(gutter(row)).toBe(first);
});
