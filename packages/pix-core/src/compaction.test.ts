import { describe, expect, it } from "bun:test";
import { compactionThresholdTokens } from "./compaction.ts";

describe("compactionThresholdTokens", () => {
	it("uses the 100k floor when the percentage threshold is lower", () => {
		expect(compactionThresholdTokens(300_000, 10, 100_000)).toBe(100_000);
	});

	it("uses the percentage threshold when it is higher than the floor", () => {
		expect(compactionThresholdTokens(1_000_000, 60, 100_000)).toBe(600_000);
	});
});
