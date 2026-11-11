/**
 * context.ts — Extract parent conversation context for subagent inheritance.
 */

import type { ExtensionContext } from "@xynogen/pix-runtime/host";

/** Extract text from a message content block array. */
export function extractText(content: unknown[]): string {
	return (content as { type: string; text?: string }[])
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

/**
 * Build a text representation of the parent conversation context.
 * Used when inherit_context is true to give the subagent visibility
 * into what has been discussed/done so far.
 *
 * A character cap (`maxChars`, default 40 000 ≈ 10k tokens) prevents the
 * serialized context from blowing the subagent's first prompt. The cap is
 * applied tail-anchored: the MOST RECENT parts are kept, oldest are dropped,
 * and a marker line indicates how many entries were omitted.
 */
export function buildParentContext(ctx: ExtensionContext, maxChars = 40_000): string {
	const entries = ctx.sessionManager.getBranch();
	if (!entries || entries.length === 0) return "";

	const parts: string[] = [];

	for (const entry of entries) {
		if (entry.type === "message") {
			const msg = entry.message;
			if (msg.role === "user") {
				const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
				if (text.trim()) parts.push(`[User]: ${text.trim()}`);
			} else if (msg.role === "assistant") {
				const text = extractText(msg.content);
				if (text.trim()) parts.push(`[Assistant]: ${text.trim()}`);
			}
			// Skip toolResult messages — too verbose for context
		} else if (entry.type === "compaction") {
			// Include compaction summaries — they're already condensed
			if (entry.summary) {
				parts.push(`[Summary]: ${entry.summary}`);
			}
		}
	}

	if (parts.length === 0) return "";

	// Tail-anchored budget: walk from the end, accumulating lengths (each part
	// separated by "\n\n"), until the budget is exhausted.
	let budget = maxChars;
	let firstKept = parts.length; // index of the first part we keep
	for (let i = parts.length - 1; i >= 0; i--) {
		// Account for the "\n\n" separator between parts (except the last one)
		const part = parts[i];
		if (!part) break;
		const cost = part.length + (i < parts.length - 1 ? 2 : 0);
		if (budget - cost < 0) break;
		budget -= cost;
		firstKept = i;
	}

	const omitted = firstKept;
	const kept = parts.slice(firstKept);
	const marker =
		omitted > 0
			? `[…earlier context omitted (${omitted} older ${omitted === 1 ? "entry" : "entries"})]\n\n`
			: "";

	return `# Parent Conversation Context
The following is the conversation history from the parent session that spawned you.
Use this context to understand what has been discussed and decided so far.

${marker}${kept.join("\n\n")}

---
# Your Task (below)
`;
}
