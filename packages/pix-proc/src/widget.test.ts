import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	colorToHex,
	rgbColor,
	stripTerminalSequences,
	styleText,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { captureRows, roleTheme } from "../../../scripts/ui-capture.ts";
import type { ProcMeta } from "./format.ts";
import { processRow } from "./widget.ts";

const meta: ProcMeta = {
	handle: "proc-dev",
	command: "bun run dev",
	cwd: "/fixture",
	pid: 1,
	pgid: 1,
	startTime: 0,
	status: "running",
	capped: false,
};

const theme = roleTheme() as unknown as Theme;

describe("process activity row", () => {
	test("keeps identity, state chips, and right-aligned timer on one row", () => {
		const row = processRow({ ...meta, capped: true, logError: "disk full" }, 42_000, 100, theme);
		const text = stripTerminalSequences(row);
		expect(text).toMatch(
			/^ {2}\S+ proc-dev {2}bun run dev +running {3}capped {3}log error {3}42s {2}$/,
		);
		expect(visibleWidth(row)).toBe(100);
		const semantic = captureRows(
			{ render: () => [row] },
			{ width: 100, surface: "component" },
		).join("\n");
		expect(semantic).toMatch(/<accent\+bg:customMessageBg>proc-dev<\//);
		expect(semantic).toMatch(/<error\+bg:selectedBg> log error <\//);
		expect(semantic).toMatch(/<muted\+bg:selectedBg> 42s <\//);
	});

	test("timer advances and completed states remain explicit", () => {
		for (const [status, exitCode, word] of [
			["exited", 0, "exited(0)"],
			["exited", 1, "exited(1)"],
			["killed", undefined, "killed"],
		] as const) {
			const row = processRow({ ...meta, status, exitCode }, 65_000, 100, theme);
			expect(stripTerminalSequences(row)).toContain(` ${word} `);
			expect(stripTerminalSequences(row)).toMatch(/ 1m05s {2}$/);
		}
		expect(stripTerminalSequences(processRow(meta, 66_000, 100, theme))).toMatch(/ 1m06s {2}$/);
	});

	for (const light of [false, true]) {
		test(`fades only overflow into the ${light ? "light" : "dark"} row background`, () => {
			const colors = {
				dim: light ? rgbColor(50, 50, 50) : rgbColor(200, 200, 200),
				customMessageBg: light ? rgbColor(245, 245, 245) : rgbColor(20, 20, 20),
			};
			const fadeColors: string[] = [];
			const fadeTheme = {
				...roleTheme(),
				colors,
				style(text: string, options: Parameters<Theme["style"]>[1]) {
					if (typeof options.fg !== "object") throw new Error("Expected concrete fade color");
					fadeColors.push(colorToHex(options.fg));
					return styleText(text, { fg: options.fg }, "truecolor");
				},
			} as unknown as Theme;
			processRow(meta, 42_000, 100, fadeTheme);
			expect(fadeColors).toEqual([]);
			const row = processRow({ ...meta, command: "abcdefghij".repeat(20) }, 42_000, 60, fadeTheme);
			expect(visibleWidth(row)).toBe(60);
			expect(fadeColors.length).toBe(8);
			expect(new Set(fadeColors).size).toBe(8);
			expect(fadeColors.at(-1)).toBe(colorToHex(colors.customMessageBg));
			expect(stripTerminalSequences(row)).toMatch(/ 42s {2}$/);

			for (const command of ["界e\u0301🙂".repeat(40), "a".repeat(200)]) {
				for (let width = 0; width <= 120; width++) {
					const narrow = processRow({ ...meta, command }, 42_000, width, fadeTheme);
					expect(visibleWidth(narrow)).toBeLessThanOrEqual(width);
					if (width >= 9) expect(stripTerminalSequences(narrow)).toMatch(/ 42s {2}$/);
				}
			}
		});
	}

	test("puts a bounded friendly name before the command, with status anchored right", () => {
		const row = processRow(
			{ ...meta, name: "Frontend", command: "bun run dev" },
			42_000,
			100,
			theme,
		);
		expect(stripTerminalSequences(row)).toMatch(
			/^ {2}\S+ Frontend {2}bun run dev +running {3}42s {2}$/,
		);
	});

	test("keeps terminal controls and masked environment secrets out of labels", () => {
		const row = processRow(
			{ ...meta, name: "server\nname", command: "TOKEN=hidden bun\x1b[31m run\r dev" },
			42_000,
			120,
			theme,
		);
		expect(stripTerminalSequences(row)).toMatch(/server name {2}TOKEN=\*\*\* bun run dev/);
	});
});
