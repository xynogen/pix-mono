import { describe, expect, test } from "bun:test";
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
} from "./widget.ts";

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

	test("running heading is hollow and shows the running count", () => {
		const out = render([job({ id: 7, model: "GPT" })]);
		expect(out).toContain("\u25cb BTW (1)");
		expect(out).toContain("#7");
		expect(out).toContain("[GPT]");
	});

	test("finished jobs linger with a check, then drop after the window", () => {
		const done = job({ status: "completed", completedAt: 1_000, toolUses: 2, turnCount: 1 });
		// Default base 10s × 3 = 30s ok-window.
		expect(shouldShowFinished(done, 1_500)).toBe(true);
		expect(shouldShowFinished(done, 40_000)).toBe(false); // 39s elapsed > 30s window

		const out = render([done], 1_500);
		expect(out).toContain("\u2713");
		// All jobs finished → filled heading disk.
		expect(out).toContain("\u25cf BTW (0)");
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
		expect(lines.length).toBeLessThanOrEqual(12);
		expect(lines.at(-1)).toContain("more");
	});

	test("hasVisibleJobs mirrors render visibility", () => {
		expect(hasVisibleJobs([job({})], 1_000)).toBe(true);
		expect(hasVisibleJobs([job({ status: "completed", completedAt: 0 })], 999_999)).toBe(false);
	});
});
