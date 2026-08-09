import { describe, expect, test } from "bun:test";
import {
	describeActivity,
	fmtTokenCount,
	formatContext,
	formatDuration,
	formatMs,
	formatSpeed,
	formatTokens,
	formatToolUses,
	formatTurns,
	getSessionContextPercent,
	getSessionContextUsage,
	SPINNER,
	truncateLine,
} from "./widget-format.ts";

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

describe("widget formatters", () => {
	test("SPINNER has frames to cycle", () => {
		expect(SPINNER.length).toBeGreaterThan(1);
	});

	test("fmtTokenCount scales with magnitude", () => {
		expect(fmtTokenCount(500)).toBe("500");
		expect(fmtTokenCount(30_100)).toBe("30.1K");
		expect(fmtTokenCount(1_000_000)).toBe("1.00M");
	});

	test("formatTokens uses ' token' / 'k token' / 'M token' variants", () => {
		expect(stripAnsi(formatTokens(500))).toContain("500 token");
		expect(stripAnsi(formatTokens(12_400))).toContain("12.4k token");
		expect(stripAnsi(formatTokens(2_500_000))).toContain("2.5M token");
	});

	test("formatMs renders seconds to one decimal", () => {
		expect(formatMs(2_100)).toBe("2.1s");
	});

	test("formatDuration keeps 3 presentations via style param", () => {
		expect(formatDuration(420, "bash")).toBe("420ms");
		expect(formatDuration(2_450, "bash")).toBe("2.5s");
		expect(formatDuration(12_400, "bash")).toBe("12s");
		expect(formatDuration(450, "btw")).toBe("450ms");
		expect(formatDuration(2_100, "btw")).toBe("2.1s");
		expect(formatDuration(12_400, "btw")).toBe("12s");
		expect(formatDuration(65_000, "btw")).toBe("1m 5s");
		expect(formatDuration(2_100)).toBe("2.1s");
		expect(formatDuration(2_100, "ms")).toBe(formatMs(2_100));
	});

	test("formatSpeed returns empty when there is no work", () => {
		expect(formatSpeed(0, 1_000)).toBe("");
		expect(formatSpeed(100, 0)).toBe("");
		expect(stripAnsi(formatSpeed(200, 2_000))).toBe("100 t/s");
	});

	test("formatContext shows used/window/percent, or empty when unknown", () => {
		expect(formatContext(null)).toBe("");
		expect(formatContext({ tokens: null, contextWindow: null, percent: null })).toBe("");
		expect(
			stripAnsi(formatContext({ tokens: 30_100, contextWindow: 1_000_000, percent: 3 })),
		).toContain("30.1K/1.00M (3%)");
		expect(stripAnsi(formatContext({ tokens: null, contextWindow: null, percent: 42 }))).toContain(
			"42% ctx",
		);
	});

	test("formatTurns and formatToolUses render counts", () => {
		expect(stripAnsi(formatTurns(3))).toContain("3");
		expect(stripAnsi(formatTurns(3, 10))).toContain("3\u226410");
		expect(stripAnsi(formatToolUses(5))).toContain("5");
	});

	test("truncateLine tail-anchors the latest non-empty line to len", () => {
		expect(truncateLine("short", 32)).toBe("short");
		expect(truncateLine("a\nb\nlatest", 32)).toBe("latest");
		expect(truncateLine("0123456789", 4)).toBe("\u20266789");
	});

	test("describeActivity groups active tools, tails text (default 32), else thinking", () => {
		const two = new Map<string, string>([
			["0", "read"],
			["1", "read"],
		]);
		expect(describeActivity(two)).toBe("reading 2\u00d7\u2026");
		expect(describeActivity(new Map(), "line one\nlatest line")).toBe("latest line");
		expect(describeActivity(new Map())).toBe("thinking\u2026");
	});

	test("describeActivity honors an explicit tailLen", () => {
		expect(describeActivity(new Map(), "0123456789", 4)).toBe("\u20266789");
	});

	test("getSessionContextUsage reads stats and tolerates throwing sessions", () => {
		const session = {
			getSessionStats: () => ({
				tokens: { input: 0, output: 0, cacheWrite: 0 },
				contextUsage: { tokens: 10, contextWindow: 100, percent: 10 },
			}),
		};
		expect(getSessionContextUsage(session)).toEqual({
			tokens: 10,
			contextWindow: 100,
			percent: 10,
		});
		expect(getSessionContextUsage(undefined)).toBeNull();
		const throwing = {
			getSessionStats: () => {
				throw new Error("no stats");
			},
		};
		expect(getSessionContextUsage(throwing)).toBeNull();
	});

	test("getSessionContextPercent returns just the percent, or null", () => {
		const session = {
			getSessionStats: () => ({
				tokens: { input: 0, output: 0, cacheWrite: 0 },
				contextUsage: { tokens: 10, contextWindow: 100, percent: 42 },
			}),
		};
		expect(getSessionContextPercent(session)).toBe(42);
		expect(getSessionContextPercent(undefined)).toBeNull();
	});
});
