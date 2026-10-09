import { describe, expect, it } from "bun:test";
import {
	compactionThresholdTokens,
	resumeDecisionAfterCompaction,
	shrinkContent,
} from "./compaction.ts";

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

describe("shrinkContent", () => {
	it("keeps head and tail of oversized text and marks the cut", () => {
		const big = `HEAD${"x".repeat(200_000)}TAIL`;
		const out = shrinkContent(big);
		expect(out?.saved).toBeGreaterThan(150_000);
		expect(out?.content).toMatch(/^HEAD[\s\S]*chars trimmed by pix compaction[\s\S]*TAIL$/);
	});

	it("trims only oversized text parts and leaves images intact", () => {
		const image = { type: "image", data: "abc", mimeType: "image/png" };
		const out = shrinkContent([{ type: "text", text: "y".repeat(100_000) }, image]);
		expect(out?.content).toEqual([{ type: "text", text: expect.stringMatching(/trimmed/) }, image]);
	});

	it("is idempotent: trimmed output fits under the limit", () => {
		const once = shrinkContent("z".repeat(500_000))?.content as string;
		expect(shrinkContent(once)).toBeUndefined();
		expect(shrinkContent("small")).toBeUndefined();
	});
});
