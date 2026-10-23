import { describe, expect, it } from "bun:test";
import registerCompaction, {
	compactionThresholdTokens,
	formatFileLists,
	maskedRead,
	mergeFileLists,
	resumeDecisionAfterCompaction,
	shrinkContent,
	staleReads,
	summaryFailure,
	summaryPrompt,
} from "./compaction.ts";

describe("summaryPrompt", () => {
	it("puts data blocks first and the instructions last", () => {
		const p = summaryPrompt({
			conversation: "[User]: hi",
			turnPrefix: "[User]: fix bug",
			previousSummary: "## Goal\nold",
			customInstructions: "  focus on tests ",
		});
		expect(p).toMatch(
			/^<conversation>\n\[User\]: hi\n<\/conversation>\n\n<turn-prefix>[\s\S]*<\/turn-prefix>\n\n<previous-summary>[\s\S]*<\/previous-summary>\n\nSummarize the OLDER part/,
		);
		expect(p).toMatch(/## Turn Context[\s\S]*\n\nAdditional focus: focus on tests$/);
	});

	it("omits optional blocks when absent", () => {
		const p = summaryPrompt({ conversation: "[User]: hi" });
		expect(p).toMatch(
			/^<conversation>[\s\S]*<\/conversation>\n\nSummarize[\s\S]*error messages\.$/,
		);
	});
});

describe("mergeFileLists", () => {
	it("merges new ops with the previous summary's tags and strips them from the text", () => {
		const prev = `## Goal\nx${formatFileLists(["a.ts", "b.ts"], ["c.ts"])}`;
		const r = mergeFileLists(
			{ read: new Set(["d.ts"]), written: new Set(["b.ts"]), edited: new Set() },
			prev,
		);
		expect(r).toEqual({
			readFiles: ["a.ts", "d.ts"],
			modifiedFiles: ["b.ts", "c.ts"],
			previousSummary: "## Goal\nx",
		});
	});

	it("formats nothing when no files were touched", () => {
		expect(formatFileLists([], [])).toBe("");
	});
});

describe("summaryFailure", () => {
	it("accepts a normal stop and rejects truncated, failed, or tool-calling responses", () => {
		const text = [{ type: "text" }];
		expect(summaryFailure({ stopReason: "stop", content: text })).toBeUndefined();
		expect(summaryFailure({ stopReason: "length", content: text })).toMatch(/output limit/);
		expect(summaryFailure({ stopReason: "error", errorMessage: "503", content: [] })).toBe("503");
		expect(summaryFailure({ stopReason: "toolUse", content: [{ type: "toolCall" }] })).toMatch(
			/tool/,
		);
	});
});

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

describe("stale read masking", () => {
	const call = (id: string, path: string) => ({
		sourceEntry: { id: `a-${id}`, type: "message" },
		messages: [{ role: "assistant", content: [{ type: "toolCall", id, arguments: { path } }] }],
	});
	const result = (id: string, toolName: string, text = "body", isError = false) => ({
		sourceEntry: { id: `r-${id}`, type: "message" },
		messages: [
			{ role: "toolResult", toolCallId: id, toolName, isError, content: [{ type: "text", text }] },
		],
	});
	const entries = [
		call("1", "a.ts"),
		result("1", "read", "A".repeat(1000)), // read a.ts → later edited: stale
		call("2", "./b.ts"),
		result("2", "read"), // read b.ts → never edited: kept
		call("3", "/repo/a.ts"),
		result("3", "edit"),
		call("4", "a.ts"),
		result("4", "read"), // re-read after the edit: fresh, kept
		call("5", "b.ts"),
		result("5", "write", "boom", true), // failed write does not stale b.ts
	];
	const resolvePath = (p: string) => (p.startsWith("/") ? p : `/repo/${p.replace(/^\.\//, "")}`);

	it("masks only reads superseded by a later successful edit/write of the same path", () => {
		expect(staleReads(entries, resolvePath)).toEqual([{ id: "r-1", path: "/repo/a.ts" }]);
	});

	it("is idempotent: an already-masked read is not masked again", () => {
		const masked = [call("1", "a.ts"), result("1", "read", maskedRead("/repo/a.ts"))];
		expect(staleReads([...masked, call("3", "a.ts"), result("3", "edit")], resolvePath)).toEqual(
			[],
		);
	});

	it("agent_before_settle emits a visible context_edit stub over the threshold", () => {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		registerCompaction({
			on: (name: string, fn: (e: unknown, c: unknown) => unknown) => handlers.set(name, fn),
		} as unknown as Parameters<typeof registerCompaction>[0]);
		const notices: string[] = [];
		const out = handlers.get("agent_before_settle")?.(
			{ entries: [], context: { contextEntries: entries } },
			{
				cwd: "/repo",
				getContextUsage: () => ({ tokens: 10_000_000, contextWindow: 1_000_000 }),
				ui: { notify: (m: string) => notices.push(m) },
			},
		) as { entries: unknown[] };
		expect(out.entries).toEqual([
			{
				type: "context_edit",
				targetId: "r-1",
				replacement: { content: [{ type: "text", text: maskedRead("/repo/a.ts") }] },
			},
		]);
		expect(notices).toEqual([
			expect.stringMatching(/^Compaction: masked 1 stale read\(s\), trimmed 0/),
		]);
	});
});

describe("auto-compaction trigger", () => {
	function settle(aborted: boolean): number {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const pi = {
			on: (name: string, fn: (e: unknown, c: unknown) => unknown) => handlers.set(name, fn),
		};
		registerCompaction(pi as unknown as Parameters<typeof registerCompaction>[0]);
		let compacts = 0;
		const ctx = {
			getContextUsage: () => ({ tokens: 10_000_000, contextWindow: 1_000_000 }),
			ui: { notify: () => {} },
			compact: () => {
				compacts++;
			},
		};
		handlers.get("agent_settled")?.({ aborted }, ctx);
		return compacts;
	}

	it("compacts a completed run above threshold and leaves an aborted run alone", () => {
		expect(settle(false)).toBe(1);
		expect(settle(true)).toBe(0);
	});
});
