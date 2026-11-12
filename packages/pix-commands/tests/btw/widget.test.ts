import { describe, expect, test } from "bun:test";
import {
	rgbColor,
	stripTerminalSequences,
	styleText,
	type TextStyle,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	type BtwWidgetJob,
	DEFAULT_LINGER_BASE_MS,
	ERROR_LINGER_SCALE,
	hasVisibleJobs,
	lingerWindows,
	OK_LINGER_SCALE,
	renderBtwWidget,
	shouldShowFinished,
	type WidgetTheme,
} from "../../src/btw/widget.ts";

const theme: WidgetTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

function job(overrides: Partial<BtwWidgetJob>): BtwWidgetJob {
	return {
		id: 1,
		model: "Model",
		status: "running",
		startedAt: 0,
		activeTools: [],
		text: "",
		toolUses: 0,
		turnCount: 0,
		outputTokens: 0,
		contextUsage: null,
		...overrides,
	};
}

const render = (jobs: BtwWidgetJob[], now = 1_000) =>
	renderBtwWidget(jobs, theme, 0, now, 200).join("\n");

describe("BTW widget layout", () => {
	test("empty when there are no running or lingering jobs", () => {
		expect(renderBtwWidget([], theme, 0, 1_000, 200)).toEqual([]);
		const old = job({ status: "completed", completedAt: 0 });
		expect(renderBtwWidget([old], theme, 0, 999_999, 200)).toEqual([]);
	});

	test("each job adds one content row and the title appears only once", () => {
		const out = render([job({ id: 7, model: "GPT" })]);
		expect(out).toMatch(/.+ BTW {6}│ #7 \[GPT\] · thinking.* {2,}1\.0s$/);
		expect(renderBtwWidget([job({})], theme, 0, 1_000, 200)).toHaveLength(2);
		const rows = renderBtwWidget([job({}), job({ id: 2 })], theme, 0, 1_000, 200);
		expect(rows).toHaveLength(3);
		expect(rows[2]).toMatch(/^ +│ #2/);
		expect(visibleWidth(rows[1]!.split("│")[0]!)).toBe(visibleWidth(rows[2]!.split("│")[0]!));
		expect(rows.join("\n").match(/BTW/g)).toHaveLength(1);
		expect(out).toContain("#7");
		expect(out).toContain("[GPT]");
	});

	test("uses primary identity, secondary activity, and tertiary metadata", () => {
		const taggedTheme: WidgetTheme = {
			fg: (color, text) => `<${color}>${text}</${color}>`,
			bold: (text) => text,
		};
		const output = renderBtwWidget(
			[job({ id: 7, model: "GPT", text: "Reading auth.ts", toolUses: 2 })],
			taggedTheme,
			0,
			1_000,
			500,
		).join("\n");
		expect(output).toMatch(
			/<toolTitle>.+ BTW {5}<\/toolTitle><muted> │ <\/muted><toolTitle>#7<\/toolTitle>/,
		);
		expect(output).toContain("<toolTitle>#7</toolTitle>");
		expect(output).toContain("<muted>[GPT]</muted>");
		expect(output).toMatch(/<muted>[^<]*2 · 1\.0s<\/muted>/);
		expect(output).toContain("<dim>Reading auth.ts</dim>");
		expect(output.split("\n")[0]).toBe(`<borderMuted>${"─".repeat(500)}</borderMuted>`);
		expect(output.split("\n")).toHaveLength(2);
	});

	test("finished jobs linger with a check, then drop after the window", () => {
		const done = job({ status: "completed", completedAt: 1_000, toolUses: 2, turnCount: 1 });
		// Default base 10s × 3 = 30s ok-window.
		expect(shouldShowFinished(done, 1_500)).toBe(true);
		expect(shouldShowFinished(done, 40_000)).toBe(false); // 39s elapsed > 30s window

		const out = render([done], 1_500);
		expect(out).toContain("\u2713");
		expect(out).toMatch(/BTW {6}│ #1 \[Model\] · completed {2,}/);
	});

	test("errors linger longer and show the message", () => {
		const failed = job({ status: "error", completedAt: 1_000, error: "boom" });
		// Default base 10s × 9 = 90s error-window; 40s elapsed is past ok (30s) but well inside error.
		expect(shouldShowFinished(failed, 40_000)).toBe(true);
		expect(render([failed], 40_000)).toContain("boom");
	});

	test("linger windows scale off the config collapse delay", () => {
		// Defaults derive from the fallback base.
		expect(lingerWindows()).toEqual({
			ok: DEFAULT_LINGER_BASE_MS * OK_LINGER_SCALE,
			error: DEFAULT_LINGER_BASE_MS * ERROR_LINGER_SCALE,
		});
		// A custom base (e.g. config collapse.delaySec = 4 → 4000ms) scales both.
		expect(lingerWindows(4_000)).toEqual({ ok: 12_000, error: 36_000 });
		// Non-positive base falls back to the default so windows never collapse to 0.
		expect(lingerWindows(0)).toEqual(lingerWindows());

		// shouldShowFinished honors the threaded base: a 4s base drops an ok job at 13s.
		const done = job({ status: "completed", completedAt: 0 });
		expect(shouldShowFinished(done, 11_000, 4_000)).toBe(true); // < 12s
		expect(shouldShowFinished(done, 13_000, 4_000)).toBe(false); // > 12s
	});

	test("overflow collapses excess rows into a +N more line", () => {
		const many = Array.from({ length: 20 }, (_, i) => job({ id: i + 1 }));
		const lines = renderBtwWidget(many, theme, 0, 1_000, 200);
		expect(lines).toHaveLength(12);
		expect(lines[0]).toBe("─".repeat(200));
		expect(lines.at(-1)).toBe("  +10 more");
	});

	test("fades only overflowing activity and keeps model, stats and elapsed time fixed", () => {
		const fadeTheme = {
			...theme,
			colors: { dim: rgbColor(180, 180, 180), customMessageBg: rgbColor(20, 20, 20) },
			style: (text: string, style: TextStyle) => styleText(text, style, "truecolor"),
		};
		for (const width of [60, 80, 120]) {
			const rows = renderBtwWidget(
				[job({ model: "GPT", text: "界e\u0301🙂 activity ".repeat(40), toolUses: 2 })],
				fadeTheme,
				0,
				1_000,
				width,
			);
			const row = rows[1]!;
			expect(stripTerminalSequences(row)).toMatch(
				/^\S+\s+BTW {6}│ #1 \[GPT\] · .* {2,}.*2 · 1\.0s$/,
			);
			expect(row).toContain("\x1b[38;2;20;20;20m");
			for (const line of rows) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			const short = renderBtwWidget(
				[job({ model: "GPT", text: "Short", toolUses: 2 })],
				fadeTheme,
				0,
				1_000,
				width,
			)[1]!;
			expect(visibleWidth(stripTerminalSequences(row).split("1.0s")[0]!)).toBe(
				visibleWidth(stripTerminalSequences(short).split("1.0s")[0]!),
			);
		}
		for (let width = 0; width < 60; width++) {
			for (const row of renderBtwWidget(
				[job({ text: "long ".repeat(40) })],
				fadeTheme,
				0,
				1_000,
				width,
			))
				expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		}
		const error = renderBtwWidget(
			[job({ status: "error", completedAt: 1_000, error: "long error ".repeat(50) })],
			fadeTheme,
			0,
			1_500,
			60,
		)[1]!;
		expect(stripTerminalSequences(error)).toMatch(/\[Model\] · error · .* {2,}1\.0s$/);
		expect(error).toContain("\x1b[38;2;20;20;20m");
	});

	test("keeps output in the middle and stats anchored to the far right", () => {
		for (const width of [60, 100, 160]) {
			const row = renderBtwWidget(
				[job({ model: "GPT", text: "Reading" })],
				theme,
				0,
				1_000,
				width,
			)[1]!;
			expect(row).toMatch(/\[GPT\] · Reading {2,}1\.0s$/);
			expect(visibleWidth(row)).toBe(width);
			for (const text of ["", "Hi", "界e\u0301🙂", "long output ".repeat(40)]) {
				const other = stripTerminalSequences(
					renderBtwWidget([job({ model: "GPT", text })], theme, 0, 1_000, width)[1]!,
				);
				expect(visibleWidth(other.split("1.0s")[0]!)).toBe(visibleWidth(row.split("1.0s")[0]!));
				expect(visibleWidth(other)).toBe(width);
			}
		}
	});

	test("hasVisibleJobs mirrors render visibility", () => {
		expect(hasVisibleJobs([job({})], 1_000)).toBe(true);
		expect(hasVisibleJobs([job({ status: "completed", completedAt: 0 })], 999_999)).toBe(false);
	});
});
