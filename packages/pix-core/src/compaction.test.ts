import { describe, expect, it } from "bun:test";
import { resolve, sep } from "node:path";
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
	windowedMasks,
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
				replacement: {
					content: [{ type: "text", text: maskedRead(resolve("/repo/a.ts").split(sep).join("/")) }],
				},
			},
		]);
		expect(notices).toEqual([
			expect.stringMatching(/^Compaction: masked 1 stale read\(s\), trimmed 0/),
		]);
	});
});

describe("windowed output masking", () => {
	const call = (id: string, args: Record<string, unknown>) => ({
		sourceEntry: { id: `a-${id}`, type: "message" },
		messages: [{ role: "assistant", content: [{ type: "toolCall", id, arguments: args }] }],
	});
	const result = (id: string, toolName: string, text: string, isError = false) => ({
		sourceEntry: { id: `r-${id}`, type: "message" },
		messages: [
			{ role: "toolResult", toolCallId: id, toolName, isError, content: [{ type: "text", text }] },
		],
	});
	const big = "x".repeat(40_000); // ~10k tok, over the 5k default gate
	const entries = [
		call("1", { command: "npm test\n  --verbose" }),
		result("1", "bash", big), // old bash: masked
		call("2", { pattern: "TODO" }),
		result("2", "grep", "boom", true), // old error: kept
		call("3", { path: "a.ts" }),
		result("3", "edit", big), // edit output is not maskable
		call("4", { pattern: "*.ts" }),
		result("4", "find", "[pix compaction: output masked — find *.ts; run again]"), // already masked
		call("5", { path: "b.ts" }),
		result("5", "read", "short"), // newest two: inside the window
		call("6", { command: "ls" }),
		result("6", "bash", big),
	];

	it("masks only older, successful bash/grep/find/ls/read output outside the window", () => {
		const out = windowedMasks(entries, 2);
		expect(out.map((m) => m.id)).toEqual(["r-1"]);
		expect(out[0]?.text).toMatch(
			/^\[pix compaction: output masked — bash npm test --verbose; run again if needed\. Original kept in session file\.\]$/,
		);
		expect(out[0]?.saved).toBeGreaterThan(39_000);
		expect(windowedMasks(entries, 2, new Set(["r-1"]))).toEqual([]);
		expect(windowedMasks(entries, 10)).toEqual([]);
	});

	function settle(contextEntries: unknown[], tokens = 10_000_000) {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		registerCompaction({
			on: (name: string, fn: (e: unknown, c: unknown) => unknown) => handlers.set(name, fn),
		} as unknown as Parameters<typeof registerCompaction>[0]);
		const notices: string[] = [];
		const out = handlers.get("agent_before_settle")?.(
			{ entries: [], context: { contextEntries } },
			{
				cwd: "/repo",
				getContextUsage: () => ({ tokens, contextWindow: 1_000_000 }),
				ui: { notify: (m: string) => notices.push(m) },
			},
		) as { entries: Array<{ targetId: string }> } | undefined;
		return { ids: out?.entries.map((e) => e.targetId) ?? [], notices };
	}

	it("masks beyond the default window of 10 over threshold, with a visible notice", () => {
		const many = Array.from({ length: 12 }, (_, i) => [
			call(`m${i}`, { command: `cmd ${i}` }),
			result(`m${i}`, "bash", big),
		]).flat();
		const { ids, notices } = settle(many);
		expect(ids).toEqual(["r-m0", "r-m1"]);
		expect(notices).toEqual([
			expect.stringMatching(
				/^Compaction: masked 0 stale read\(s\), masked 2 older tool output\(s\) beyond the last 10 \(~[\d,]+ tok\), trimmed 0/,
			),
		]);
		expect(settle(many, 1_000).ids).toEqual([]); // under threshold: nothing runs
	});

	it("skips a pass that frees less than maskMinTokens", () => {
		const small = Array.from({ length: 12 }, (_, i) => [
			call(`s${i}`, { command: `cmd ${i}` }),
			result(`s${i}`, "bash", "y".repeat(2_000)),
		]).flat();
		expect(settle(small).ids).toEqual([]);
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
