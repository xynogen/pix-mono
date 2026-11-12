import { describe, expect, test } from "bun:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { getAgentConversation, getAgentLastTurns } from "../src/agent-runner.ts";

/** Minimal fake session — getAgentConversation only reads `.messages`. */
function fakeSession(messages: { role: string; content: unknown; toolName?: string }[]) {
	return { messages } as unknown as AgentSession;
}

describe("getAgentConversation", () => {
	test("under-budget — everything included, no marker", () => {
		const session = fakeSession([
			{ role: "user", content: "hello" },
			{
				role: "assistant",
				content: [{ type: "text", text: "hi there" }],
			},
		]);
		const result = getAgentConversation(session, 10_000);
		expect(result).toContain("[User]: hello");
		expect(result).toContain("[Assistant]: hi there");
		expect(result).not.toContain("truncated");
	});

	test("over-budget — keeps newest, marker present", () => {
		const messages = [];
		// Build enough messages to exceed a small budget
		for (let i = 0; i < 20; i++) {
			messages.push({ role: "user", content: `message number ${i}` });
			messages.push({
				role: "assistant",
				content: [{ type: "text", text: `response number ${i}` }],
			});
		}
		const session = fakeSession(messages);
		// Use a small budget so most entries are dropped
		const result = getAgentConversation(session, 200);
		expect(result).toContain("[…truncated:");
		expect(result).toContain("earlier entries omitted]");
		// The newest messages should be kept
		expect(result).toContain("19");
		// The oldest messages should be dropped
		expect(result).not.toContain("[User]: message number 0");
	});

	test("tool-result truncation to 200 chars still applies", () => {
		const longText = "x".repeat(500);
		const session = fakeSession([
			{
				role: "toolResult",
				content: [{ type: "text", text: longText }],
				toolName: "grep",
			},
		]);
		const result = getAgentConversation(session, 10_000);
		expect(result).toContain("[Tool Result (grep)]:");
		// The tool result text should be truncated to 200 chars + "..."
		expect(result).not.toContain("x".repeat(500));
		expect(result).toContain(`${"x".repeat(200)}...`);
	});

	test("empty messages returns empty string", () => {
		const session = fakeSession([]);
		const result = getAgentConversation(session, 10_000);
		expect(result).toBe("");
	});
});

describe("getAgentLastTurns", () => {
	const messages = [
		{ role: "user", content: "initial prompt" },
		{ role: "assistant", content: [{ type: "text", text: "turn 1 text" }] },
		{
			role: "toolResult",
			content: [{ type: "text", text: "t1 result" }],
			toolName: "read",
		},
		{ role: "assistant", content: [{ type: "text", text: "turn 2 text" }] },
		{
			role: "toolResult",
			content: [{ type: "text", text: "t2 result" }],
			toolName: "bash",
		},
		{ role: "assistant", content: [{ type: "text", text: "turn 3 text" }] },
	];

	test("last 1 turn — only the final assistant group", () => {
		const result = getAgentLastTurns(fakeSession(messages), 1, 10_000);
		expect(result).toContain("turn 3 text");
		expect(result).not.toContain("turn 1 text");
		expect(result).not.toContain("turn 2 text");
		expect(result).not.toContain("initial prompt");
	});

	test("last 2 turns — includes tool results between turns", () => {
		const result = getAgentLastTurns(fakeSession(messages), 2, 10_000);
		expect(result).toContain("turn 2 text");
		expect(result).toContain("turn 3 text");
		expect(result).toContain("[Tool Result (bash)]");
		expect(result).not.toContain("turn 1 text");
	});

	test("turns larger than history — returns everything from first turn on", () => {
		const result = getAgentLastTurns(fakeSession(messages), 99, 10_000);
		expect(result).toContain("turn 1 text");
		expect(result).toContain("turn 3 text");
		// leading user-only group never counts as a turn, so it stays out
		expect(result).not.toContain("initial prompt");
	});

	test("no assistant messages yet — empty string", () => {
		const result = getAgentLastTurns(fakeSession([{ role: "user", content: "hi" }]), 3, 10_000);
		expect(result).toBe("");
	});
});
