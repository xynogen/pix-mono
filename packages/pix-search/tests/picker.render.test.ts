import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { type Terminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { tempDir } from "@xynogen/pix-runtime/paths";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";
import type { FilePicker } from "../src/picker.ts";

test("picker captures threshold, filtering, scroll and observed preview completion", async () => {
	const fixture = await withUiFixture();
	const cwd = mkdtempSync(join(tempDir(), "search-capture-"));
	const env = { FORCE_COLOR: process.env.FORCE_COLOR, NO_COLOR: process.env.NO_COLOR };
	process.env.FORCE_COLOR = "3";
	delete process.env.NO_COLOR;
	let highlight: typeof import("@xynogen/pix-pretty/highlight") | undefined;
	let cache = new Map<string, string[]>();
	let chalk: { level: number } | undefined;
	let level = 0;
	try {
		chalk = createRequire(import.meta.resolve("@xynogen/pix-pretty/highlight"))("chalk");
		level = chalk!.level;
		highlight = await import("@xynogen/pix-pretty/highlight");
		cache = new Map(highlight._cache);
		highlight._cache.clear();
		const { FilePicker } = await import("../src/picker.ts");
		const theme = roleTheme();
		const rows = (picker: FilePicker, width: number) =>
			captureRows(picker, { width, surface: "component" }).join("\n");
		let selected: string | null | undefined;
		const picker = new FilePicker({
			files: ["src/", "src/a.ts", "src/deep/b.ts"],
			recency: new Map(),
			cwd,
			theme,
			done: (path) => {
				selected = path;
			},
		});
		expect(rows(picker, 75)).toMatchSnapshot("75 single column");
		expect(rows(picker, 76)).toMatchSnapshot("76 directory preview");
		picker.handleInput("\x1b[B");
		picker.handleInput("\x1b[A");
		picker.handleInput("\r");
		expect(selected).toBe("src/");
		picker.handleInput("\x1b");
		expect(selected).toBeNull();
		picker.setFiles(["a b/", "a b/a.ts"]);
		for (const key of "a b") picker.handleInput(key);
		expect(rows(picker, 48)).toMatchSnapshot("filtered spaces");
		picker.handleInput("\x7f");
		picker.handleInput("z");
		expect(rows(picker, 48)).toMatchSnapshot("no matches");
		const empty = new FilePicker({ files: [], recency: new Map(), cwd, theme, done() {} });
		expect(rows(empty, 48)).toMatchSnapshot("empty candidates");
		const files = Array.from({ length: 12 }, (_, index) => `f${String(index).padStart(2, "0")}.ts`);
		const scrolled = new FilePicker({
			files,
			recency: new Map(),
			cwd,
			theme,
			done: (path) => {
				selected = path;
			},
		});
		for (let i = 0; i < 11; i++) scrolled.handleInput("\x1b[B");
		expect(rows(scrolled, 48)).toMatchSnapshot("scrolled");
		scrolled.handleInput("x");
		scrolled.handleInput("\x7f");
		scrolled.handleInput("\r");
		expect(selected).toBe("f00.ts");
		writeFileSync(join(cwd, "sample.ts"), "const count = 2;\n  // fixed preview\n");
		let notify!: () => void;
		const highlighted = new Promise<void>((resolve) => {
			notify = resolve;
		});
		const file = new FilePicker({
			files: ["sample.ts"],
			recency: new Map(),
			cwd,
			theme,
			done() {},
			onChange: notify,
		});
		try {
			expect(rows(file, 76)).toMatchSnapshot("plain preview");
		} finally {
			await highlighted;
		}
		expect(rows(file, 76)).toMatchSnapshot("highlighted preview");
		file.setFiles(["other/"]);
		expect(rows(file, 76)).toContain("other/");
	} finally {
		if (chalk) chalk.level = level;
		highlight?._cache.clear();
		for (const [key, value] of cache) highlight?._cache.set(key, value);
		for (const [key, value] of Object.entries(env)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		try {
			rmSync(cwd, { recursive: true, force: true });
		} finally {
			await fixture.restore();
		}
	}
});

test("actual host constrains picker to the centered 60% overlay rectangle", async () => {
	const fixture = await withUiFixture();
	// ponytail: expose the host compositor, not terminal I/O. Full-screen terminal capture stays with the integrator.
	class OverlayProbe extends TuiMainScreen {
		override requestRender() {}
		compose(width: number, height: number) {
			return this.compositeOverlays(Array(height).fill(""), width, height);
		}
	}
	const terminal = {
		columns: 80,
		rows: 40,
		hideCursor() {},
		showCursor() {},
		write() {},
		stop() {},
	} as unknown as Terminal;
	const tui = new OverlayProbe(terminal);
	try {
		const { FilePicker } = await import("../src/picker.ts");
		let supplied = 0;
		const picker = new FilePicker({
			files: ["src/", "src/a.ts"],
			recency: new Map(),
			cwd: fixture.agentDir,
			theme: roleTheme(),
			done() {},
		});
		const overlay = tui.showOverlay(
			{
				render(width) {
					supplied = width;
					return picker.render(width);
				},
				invalidate() {
					picker.invalidate();
				},
			},
			{ anchor: "center", width: "60%", maxHeight: "60%" },
		);
		const screen = tui.compose(80, 40);
		expect(supplied).toBe(48);
		expect(overlay.getBounds()).toEqual({ row: 15, col: 16, width: 48, height: 10 });
		expect(screen).toHaveLength(40);
		expect(
			captureRows(picker, { width: supplied, surface: "component" }).join("\n"),
		).toMatchSnapshot("80 terminal constrained picker");
		overlay.hide();
		expect(tui.hasOverlay()).toBe(false);
	} finally {
		try {
			tui.stop();
		} finally {
			await fixture.restore();
		}
	}
});
