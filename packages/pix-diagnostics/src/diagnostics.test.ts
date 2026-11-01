import { describe, expect, test } from "bun:test";
import { rgbColor, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { roleTheme, semanticRow } from "../../../scripts/ui-capture.ts";
import { renderWidget } from "./diagnostics.ts";
import { DiagnosticStore } from "./store.ts";

const roles = roleTheme();
const theme = {
	...roles,
	colors: { dim: rgbColor(180, 180, 180), muted: rgbColor(70, 70, 70) },
	style: (text: string) => roles.fg("muted", text),
};

describe("diagnostic widget", () => {
	test("draws a full-width top rule above the LSP row", () => {
		const store = new DiagnosticStore();
		store.set({ filePath: "/repo/a.ts", checkedAt: 1, state: "clean", diagnostics: [] });
		const lines = renderWidget(store, 80, theme as never);
		expect(semanticRow(lines[0]!)).toBe(`<borderMuted>${"─".repeat(80)}</borderMuted>`);
		expect(stripTerminalSequences(lines[1]!)).toMatch(
			/^.+ LSP {6}│ \S+ 1 clean · 1 checked · a\.ts$/,
		);
		expect(semanticRow(lines[1]!)).toMatch(
			/^<toolTitle>.+ LSP {5}<\/toolTitle><muted> │ <\/muted><success>.+ 1 clean<\/success>/,
		);
	});

	test("shows the LSP role, severity counts, and recent files", () => {
		const store = new DiagnosticStore();
		store.set({
			filePath: "/repo/src/a.ts",
			checkedAt: 2,
			state: "findings",
			diagnostics: [
				{ filePath: "/repo/src/a.ts", severity: "error", message: "bad", line: 1, column: 1 },
				{ filePath: "/repo/src/a.ts", severity: "warning", message: "warn", line: 2, column: 1 },
			],
		});

		const text = renderWidget(store, 320, theme as never).join("\n");
		expect(text).toMatch(/LSP.*1 error.*1 warning.*a\.ts/);
	});

	test("keeps recent filenames beside the counts and caps the list at three", () => {
		const store = new DiagnosticStore();
		for (const [index, name] of ["clean.ts", "a.ts", "b.ts", "c.ts", "d.ts"].entries()) {
			store.set({
				filePath: `/repo/${name}`,
				checkedAt: index,
				state: name === "clean.ts" ? "clean" : "findings",
				diagnostics:
					name === "clean.ts"
						? []
						: [
								{
									filePath: `/repo/${name}`,
									severity: "error",
									message: "bad",
									line: 1,
									column: 1,
								},
							],
			});
		}

		const text = renderWidget(store, 200, theme as never).join("\n");
		expect(text).toMatch(/d\.ts, c\.ts, b\.ts \+2/);
		expect(text).not.toContain("clean.ts");
	});

	test("separates confirmed clean files from files without an LSP result", () => {
		const store = new DiagnosticStore();
		store.set({ filePath: "/repo/a.ts", checkedAt: 1, state: "clean", diagnostics: [] });
		store.set({ filePath: "/repo/b.ts", checkedAt: 2, state: "unconfirmed", diagnostics: [] });
		store.set({ filePath: "/repo/c.ts", checkedAt: 3, state: "unavailable", diagnostics: [] });
		store.set({ filePath: "/repo/touched.ts", checkedAt: 4, state: "touched", diagnostics: [] });
		const text = renderWidget(store, 320, theme as never).join("\n");
		expect(text).toMatch(/LSP.*1 unconfirmed.*1 unavailable.*1 clean.*3 checked.*c\.ts, b\.ts/);
	});

	test("shows uncertain files beside files with findings", () => {
		const store = new DiagnosticStore();
		store.set({
			filePath: "/repo/error.ts",
			checkedAt: 1,
			state: "findings",
			diagnostics: [
				{ filePath: "/repo/error.ts", severity: "error", message: "bad", line: 1, column: 1 },
			],
		});
		store.set({
			filePath: "/repo/unknown.ts",
			checkedAt: 2,
			state: "unconfirmed",
			diagnostics: [],
		});
		const text = renderWidget(store, 320, theme as never).join("\n");
		expect(text).toMatch(/LSP.*1 error.*1 unconfirmed.*2 checked.*unknown\.ts, error\.ts/);
	});

	test("shows an unconfirmed check without claiming the file is clean at normal width", () => {
		const store = new DiagnosticStore();
		store.set({ filePath: "/repo/a.ts", checkedAt: 1, state: "unconfirmed", diagnostics: [] });
		const plain = { fg: (_role: string, text: string) => text };
		const text = renderWidget(store, 80, plain as never).join("\n");
		expect(text).toMatch(/LSP.*1 unconfirmed.*1 checked.*a\.ts/);
	});

	test("groups filenames immediately after counts at every fitting width", () => {
		const store = new DiagnosticStore();
		store.set({ filePath: "/repo/first.ts", checkedAt: 1, state: "clean", diagnostics: [] });
		store.set({ filePath: "/repo/second.ts", checkedAt: 2, state: "clean", diagnostics: [] });
		const row = renderWidget(store, 100, theme)[1]!;
		const text = stripTerminalSequences(row);
		expect(text).toMatch(/^.+ LSP {6}│ \S+ 2 clean · 2 checked · second\.ts, first\.ts$/);
		for (const width of [80, 100, 200]) {
			expect(stripTerminalSequences(renderWidget(store, width, theme)[1]!)).toBe(text);
		}
		for (const width of [1, 16, 24, 40, 60, 80]) {
			expect(visibleWidth(renderWidget(store, width, theme)[1]!)).toBeLessThanOrEqual(width);
		}
	});

	test("fades overflowing filenames without replacing the left-hand summary", () => {
		const store = new DiagnosticStore();
		store.set({
			filePath: `/repo/${"界e\u0301".repeat(30)}.ts`,
			checkedAt: 1,
			state: "clean",
			diagnostics: [],
		});
		const row = renderWidget(store, 60, theme)[1]!;
		expect(stripTerminalSequences(row)).toMatch(/^.+ LSP {6}│ \S+ 1 clean · 1 checked · 界/);
		expect(semanticRow(row)).toMatch(/<dim>.*<\/dim><muted>.*<\/muted>/);
		expect(visibleWidth(row)).toBeLessThanOrEqual(60);
		expect(renderWidget(store, 0, theme)).toEqual([]);
	});

	test("returns no row before LSP checks a file", () => {
		const store = new DiagnosticStore();
		store.set({ filePath: "/repo/touched.ts", checkedAt: 1, state: "touched", diagnostics: [] });
		expect(renderWidget(store, 80, theme as never)).toEqual([]);
	});

	test("fits the row to the terminal width", () => {
		const store = new DiagnosticStore();
		store.set({
			filePath: "/repo/a-very-long-file-name.ts",
			checkedAt: 1,
			state: "findings",
			diagnostics: [
				{
					filePath: "/repo/a-very-long-file-name.ts",
					severity: "error",
					message: "bad",
					line: 1,
					column: 1,
				},
			],
		});
		const [, line] = renderWidget(store, 24, theme as never);
		expect(visibleWidth(line ?? "")).toBeLessThanOrEqual(24);
	});
});
