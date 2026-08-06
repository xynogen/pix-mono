import { describe, expect, it } from "bun:test";
import { compactionThresholdTokens, resumeDecisionAfterCompaction } from "./compaction.ts";

describe("compactionThresholdTokens", () => {
	it("uses the 100k floor when the percentage threshold is lower", () => {
		expect(compactionThresholdTokens(300_000, 10, 100_000)).toBe(100_000);
	});

	it("uses the percentage threshold when it is higher than the floor", () => {
		expect(compactionThresholdTokens(1_000_000, 60, 100_000)).toBe(600_000);
	});
});

describe("resumeDecisionAfterCompaction", () => {
	const threshold = 100_000;

	it("resumes when idle, no pending messages, and under threshold", () => {
		expect(
			resumeDecisionAfterCompaction({
				estimatedTokensAfter: 40_000,
				threshold,
				idle: true,
				hasPending: false,
			}),
		).toBe("resume");
	});

	it("skips when the agent is busy with the user's in-flight prompt", () => {
		expect(
			resumeDecisionAfterCompaction({
				estimatedTokensAfter: 40_000,
				threshold,
				idle: false,
				hasPending: false,
			}),
		).toBe("skip");
	});

	it("skips when the user has a prompt queued during compaction", () => {
		expect(
			resumeDecisionAfterCompaction({
				estimatedTokensAfter: 40_000,
				threshold,
				idle: true,
				hasPending: true,
			}),
		).toBe("skip");
	});

	it("latches off (loop) when still at/above threshold after compaction", () => {
		expect(
			resumeDecisionAfterCompaction({
				estimatedTokensAfter: threshold,
				threshold,
				idle: true,
				hasPending: false,
			}),
		).toBe("loop");
	});

	it("treats a missing estimate as 0 tokens (does not latch)", () => {
		expect(
			resumeDecisionAfterCompaction({
				estimatedTokensAfter: undefined,
				threshold,
				idle: true,
				hasPending: false,
			}),
		).toBe("resume");
	});

	it("loop takes priority over a busy agent", () => {
		expect(
			resumeDecisionAfterCompaction({
				estimatedTokensAfter: 200_000,
				threshold,
				idle: false,
				hasPending: true,
			}),
		).toBe("loop");
	});
});
