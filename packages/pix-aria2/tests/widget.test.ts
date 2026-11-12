import { expect, test } from "bun:test";
import {
	rgbColor,
	stripTerminalSequences,
	styleText,
	type TextStyle,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import type { DlStatus } from "../src/format.ts";
import { renderDownloadWidget } from "../src/widget.ts";

const theme = {
	fg: (_role: string, text: string) => text,
	bg: () => {
		throw new Error("Download widget must preserve the terminal background");
	},
	colors: { dim: rgbColor(180, 180, 180), muted: rgbColor(60, 60, 60) },
	style: (text: string, style: TextStyle) => styleText(text, style, "truecolor"),
};
const download: DlStatus = {
	gid: "abc",
	status: "active",
	totalLength: "1000",
	completedLength: "250",
	downloadSpeed: "100",
	files: [
		{
			path: "/downloads/界e\u0301🙂-very-long-file-name.iso",
			uris: [{ uri: `https://example.test/${"long-path/".repeat(15)}` }],
		},
	],
};

test("download rows keep faded filename/URL left, a proportional bar, and aligned stats right", () => {
	const rows = renderDownloadWidget(
		[download, { ...download, files: [{ path: "/short.iso" }] }],
		150,
		theme,
	);
	const plain = rows.map(stripTerminalSequences);
	expect(rows).toHaveLength(3);
	expect(plain[0]).toBe("─".repeat(150));
	expect(plain[1]).toMatch(
		/^\S+\s+Download │ 界.*https:.*█{6}░{18} {2}25% · 250 B\/1000 B · 100 B\/s · eta 8s$/,
	);
	expect(plain[2]).toMatch(/^ +│ short\.iso.*█{6}░{18} {2}25%/);
	expect(visibleWidth(plain[1]!.split("│")[0]!)).toBe(visibleWidth(plain[2]!.split("│")[0]!));
	expect(visibleWidth(plain[1]!.split("25%")[0]!)).toBe(visibleWidth(plain[2]!.split("25%")[0]!));
	expect(rows[1]).toContain("\x1b[38;2;60;60;60m");
	for (const row of rows) expect(row).not.toMatch(/\x1b\[(?:48[;:]|4[0-7]m)/);
	const track = rows[1]!.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m░{18}/);
	expect(track).not.toBeNull();
	for (const value of track!.slice(1).map(Number)) {
		expect(value).toBeGreaterThan(60);
		expect(value).toBeLessThan(180);
	}
	expect(rows.slice(1).map(visibleWidth)).toEqual([150, 150]);
});

test("each download adds one content row without a separate heading", () => {
	const single = renderDownloadWidget([download], 150, theme).map(stripTerminalSequences);
	expect(single).toHaveLength(2);
	expect(single[1]).toMatch(/^\S+\s+Download │ 界.*https:.*█.*25%/);
	const multiple = renderDownloadWidget([download, download], 150, theme).map(
		stripTerminalSequences,
	);
	expect(multiple).toHaveLength(3);
	expect(multiple.join("\n").match(/Download/g)).toHaveLength(1);
});

test("render width is respected for Unicode, unknown totals, errors, and completion", () => {
	for (const status of [
		download,
		{ ...download, totalLength: "0" },
		{ ...download, status: "error" },
		{ ...download, completedLength: "1000" },
	] as DlStatus[]) {
		for (let width = 0; width <= 160; width++) {
			const rows = renderDownloadWidget([status], width, theme);
			expect(rows.length).toBe(width ? 2 : 0);
			for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		}
	}
	const unknown = stripTerminalSequences(
		renderDownloadWidget([{ ...download, totalLength: "0" }], 120, theme)[1]!,
	);
	expect(unknown).toMatch(/░{4,24} {2}\? · 250 B\/\? · 100 B\/s$/);
	const complete = stripTerminalSequences(
		renderDownloadWidget([{ ...download, completedLength: "1000" }], 150, theme)[1]!,
	);
	expect(complete).toMatch(/█{24} {2}100%/);
	expect(complete.trimStart()).toStartWith(icon("update"));
	expect(renderDownloadWidget([], 80, theme)).toEqual([]);
});

test("invalid completion values stay within the progress bar bounds", () => {
	for (const completedLength of ["-10", "NaN", "Infinity", "2000"]) {
		const rows = renderDownloadWidget([{ ...download, completedLength }], 100, theme);
		expect(rows).toHaveLength(2);
		expect(visibleWidth(rows[1]!)).toBeLessThanOrEqual(100);
	}
});
