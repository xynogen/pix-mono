import { expect, test } from "bun:test";
import { formatStats, sessionStats } from "./session-stats.ts";

const call = (name: string, args: Record<string, unknown>) => ({
	type: "message",
	message: {
		role: "assistant",
		usage: { input: 100, output: 10, cacheRead: 50 },
		content: [{ type: "toolCall", id: name, name, arguments: args }],
	},
});
const result = (id: string, toolName: string, text: string, details?: unknown) => ({
	type: "message",
	id,
	message: { role: "toolResult", toolName, content: [{ type: "text", text }], details },
});

test("counts re-reads, masking, shell-for-tool, nudges, tool_search and graph use", () => {
	const s = sessionStats([
		call("read", { path: "a.ts" }),
		result("r1", "read", "x".repeat(3000)),
		call("read", { path: "a.ts" }),
		call("edit", { path: "a.ts" }),
		call("read", { path: "a.ts" }),
		call("bash", { command: "cat b.ts" }),
		result("r2", "bash", "out\n[pix-nudge] Use `read`"),
		call("bash", { command: "git status" }),
		call("tool_search", { query: "grep" }),
		result("r3", "tool_search", "Loaded", { loaded: ["grep", "mcp__kicad__x"] }),
		call("graph", { action: "impact" }),
		{
			type: "context_edit",
			targetId: "r1",
			replacement: {
				content: [{ type: "text", text: "[pix compaction: output masked — read a.ts" }],
			},
		},
	]);
	expect(s).toMatchObject({
		assistantTurns: 8,
		byTool: { read: 3, edit: 1, bash: 2, tool_search: 1, graph: 1 },
		cacheRead: 400,
		reads: 3,
		reReads: 1,
		topReReads: [["a.ts", 1]],
		masked: { output: 1, staleRead: 0, chars: 3000 },
		bash: 2,
		shellForTool: 1,
		nudges: 1,
		toolSearch: { calls: 1, loaded: 2, mcpLoaded: 1 },
		graph: { impact: 1 },
	});
	expect(formatStats(s)).toMatch(
		/^reads 3 · re-reads without an edit between 1 \(33%\): a\.ts \+1$/m,
	);
});
