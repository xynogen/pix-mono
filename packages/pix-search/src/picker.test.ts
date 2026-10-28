import { expect, test } from "bun:test";
import type { ThemeLike } from "@xynogen/pix-pretty/types";
import { FilePicker } from "./picker.ts";

// Mock theme: fg/bold pass through; bg wraps with a sentinel so we can assert
// the modal fill reaches frameLines. Real themes emit ANSI bg escapes here.
const BG_OPEN = "<BG>";
const BG_CLOSE = "</BG>";
const theme = {
	fg: (_key: string, text: string) => text,
	bold: (text: string) => text,
	bg: (_key: string, text: string) => `${BG_OPEN}${text}${BG_CLOSE}`,
} as unknown as ThemeLike;

function makePicker() {
	return new FilePicker({
		files: ["src/index.ts", "src/rank.ts"],
		recency: new Map(),
		theme,
		cwd: "/tmp",
		done: () => {},
	});
}

test("renders a solid background fill so the terminal does not bleed through", () => {
	const lines = makePicker().render(100);
	// Every framed row is wrapped by the theme bg — no transparent holes.
	expect(lines.length).toBeGreaterThan(0);
	expect(lines.every((l) => l.includes(BG_OPEN))).toBe(true);
});

test("omits the bg fill when the theme has no bg method (mock/partial themes)", () => {
	const bgless = {
		fg: (_key: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as ThemeLike;
	const picker = new FilePicker({
		files: ["src/index.ts"],
		recency: new Map(),
		theme: bgless,
		cwd: "/tmp",
		done: () => {},
	});
	// No throw, and no sentinel — frame still renders, just without a fill.
	const lines = picker.render(100);
	expect(lines.length).toBeGreaterThan(0);
	expect(lines.some((l) => l.includes(BG_OPEN))).toBe(false);
});

test("setFiles repaints once the async file list arrives", () => {
	let repaints = 0;
	const picker = new FilePicker({
		files: [],
		recency: new Map(),
		theme,
		cwd: "/tmp",
		done: () => {},
		onChange: () => repaints++,
	});
	picker.setFiles(["src/late.ts"]);
	expect(repaints).toBe(1);
	expect(picker.render(100).join("\n")).toContain("late.ts");
});
