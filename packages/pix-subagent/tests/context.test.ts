import { expect, test } from "bun:test";
import { buildParentContext } from "../src/context.ts";

/** Minimal fake that satisfies `buildParentContext`'s ExtensionContext shape. */
function fakeCtx(entries: { type: string; message?: unknown; summary?: string }[]) {
	return {
		sessionManager: {
			getBranch: () => entries,
		},
	} as Parameters<typeof buildParentContext>[0];
}

/** Helper: a user message entry. */
function userMsg(text: string) {
	return { type: "message", message: { role: "user", content: text } };
}

/** Helper: an assistant message entry. */
function assistantMsg(text: string) {
	return {
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
		},
	};
}

test("empty branch returns empty string", () => {
	expect(buildParentContext(fakeCtx([]))).toBe("");
	expect(buildParentContext(fakeCtx(undefined as never))).toBe("");
});

test("under-budget — everything included, no marker", () => {
	const ctx = fakeCtx([userMsg("Hello"), assistantMsg("Hi there!")]);
	const result = buildParentContext(ctx, 100_000);
	expect(result).toContain("[User]: Hello");
	expect(result).toContain("[Assistant]: Hi there!");
	// No omission marker
	expect(result).not.toContain("earlier context omitted");
	expect(result).toContain("# Parent Conversation Context");
	expect(result).toContain("# Your Task (below)");
});

test("over-budget — oldest dropped, marker present, newest retained", () => {
	// Create entries where each is ~20 chars, set maxChars so only the last one fits
	const ctx = fakeCtx([
		userMsg("A".repeat(100)),
		userMsg("B".repeat(100)),
		userMsg("C".repeat(100)),
		assistantMsg("newest entry here"),
	]);
	// Budget fits only the last entry (~40 chars with role prefix) but not all four
	const result = buildParentContext(ctx, 50);
	expect(result).toContain("[Assistant]: newest entry here");
	expect(result).toContain("earlier context omitted");
	// The oldest entries should be dropped
	expect(result).not.toContain("A".repeat(100));
});

test("over-budget — marker shows correct count of omitted entries", () => {
	const ctx = fakeCtx([userMsg("old1"), userMsg("old2"), userMsg("old3"), assistantMsg("keep")]);
	// Budget fits only "keep" (~20 chars)
	const result = buildParentContext(ctx, 30);
	expect(result).toContain("[Assistant]: keep");
	// 3 entries omitted
	expect(result).toMatch(/3 older entries/);
});

test("single omitted entry uses singular form", () => {
	const ctx = fakeCtx([userMsg("A".repeat(200)), assistantMsg("kept")]);
	const result = buildParentContext(ctx, 30);
	expect(result).toContain("1 older entry)");
});
