/**
 * Convert leaked reasoning tags into native `thinking` content blocks.
 *
 * Some openai-compatible providers leak raw <think>/<thinking> tags into the
 * visible assistant `content[].text` (the real reasoning travels the proper
 * `reasoning_content` channel). Instead of stripping or restyling them, we
 * split each affected text block into ordered `text` + `thinking` content
 * blocks. Pi renders `thinking` blocks dim + italic via the `thinkingText`
 * theme token natively (see assistant-message.ts) — no ANSI injection, no
 * markdown blockquote shim.
 *
 * Approach:
 *   - During streaming (`message_update`), rebuild the event's message so a
 *     reasoning block appears the moment the open tag streams in — no waiting
 *     for the close tag. splitThinking() captures the dangling-open case, and
 *     a trailing half-streamed tag (e.g. "<thin") is stripped so it never
 *     flashes as literal text.
 *
 *     Safety: `event.message` is a per-event shallow copy, but its content
 *     blocks are the provider's LIVE accumulating objects (providers do
 *     `block.text += delta`). We therefore never mutate text blocks in
 *     place — we replace `message.content` with fresh block objects. The
 *     TUI receives the same event object after extensions run, so the rebuilt
 *     content is what gets rendered live.
 *
 *   - On `message_end`, split every affected text block and return the
 *     replacement via the supported channel. (The finalized message comes
 *     from `response.result()` — a fresh object that never saw the streaming
 *     rebuild — so this step is still required for persistence.)
 *
 * Persistence trade-off: the replacement is persisted and round-trips to the
 * provider next turn. The synthesized `thinking` blocks carry no
 * thinkingSignature (none was received — the reasoning leaked into the text
 * channel), so signature-validating APIs (e.g. Anthropic) may reject or drop
 * them on multi-turn. Accepted in exchange for native dim+italic rendering.
 *
 * To add a new tag variant, append to TAG_NAMES below.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Reasoning tag names to render. Add new variants here.
const TAG_NAMES = ["think", "thinking"] as const;
const TAG_ALT = TAG_NAMES.join("|");

// Closed block: <think>...</think>
const CLOSED_BLOCK_RE = new RegExp(`<(${TAG_ALT})>([\\s\\S]*?)<\\/\\1>`, "gi");
// Dangling open block with no close (stream cut off, or close never emitted)
const OPEN_TAIL_RE = new RegExp(`<(${TAG_ALT})>([\\s\\S]*)$`, "i");
// Any orphan tags left over.
const ORPHAN_TAG_RE = new RegExp(`<\\/?(${TAG_ALT})>`, "gi");

interface TextBlock {
	type: "text";
	text: string;
}
interface ThinkingBlock {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
}
type Block = TextBlock | ThinkingBlock | { type: string; [k: string]: unknown };
interface Msg {
	role?: string;
	content?: Block[];
}

// Trailing half-streamed tag, e.g. "<", "</", "<thin", "</thinkin".
// Only used during streaming so an incomplete tag never flashes as text.
const PARTIAL_TAIL_RE = /<\/?([a-zA-Z]*)$/;

function stripPartialTailTag(text: string): string {
	const match = text.match(PARTIAL_TAIL_RE);
	if (!match) return text;
	const fragment = (match[1] ?? "").toLowerCase();
	if (TAG_NAMES.some((tag) => tag.startsWith(fragment))) {
		return text.slice(0, match.index);
	}
	return text;
}

// Push a text block only when it has visible content. Surrounding whitespace
// between reasoning and answer text is dropped so the native renderer doesn't
// emit stray blank paragraphs.
// True when the text contains any reasoning tag (open, close, or orphan).
function hasReasoningTag(text: string): boolean {
	ORPHAN_TAG_RE.lastIndex = 0;
	return ORPHAN_TAG_RE.test(text);
}

function pushText(blocks: Block[], text: string): void {
	const trimmed = text.trim();
	if (trimmed) blocks.push({ type: "text", text: trimmed });
}

function pushThinking(blocks: Block[], thinking: string): void {
	const trimmed = thinking.trim();
	if (trimmed) blocks.push({ type: "thinking", thinking: trimmed });
}

/**
 * Split leaked reasoning text into ordered native content blocks.
 *
 * Reasoning spans (`<think>…</think>`, plus a trailing unclosed `<think>…`)
 * become real `thinking` blocks, which pi renders dim + italic via the
 * `thinkingText` theme token — no ANSI injection, no markdown blockquote.
 * Everything else stays a `text` block. Returns the original single text
 * block unchanged when no reasoning tags are present.
 */
function splitThinking(text: string): Block[] {
	if (!hasReasoningTag(text)) {
		return [{ type: "text", text }];
	}

	const blocks: Block[] = [];
	let rest = text;

	// Consume closed reasoning blocks left-to-right, preserving order with the
	// surrounding answer text.
	CLOSED_BLOCK_RE.lastIndex = 0;
	let match = CLOSED_BLOCK_RE.exec(rest);
	while (match) {
		pushText(blocks, rest.slice(0, match.index));
		pushThinking(blocks, match[2] ?? "");
		rest = rest.slice(match.index + match[0].length);
		CLOSED_BLOCK_RE.lastIndex = 0;
		match = CLOSED_BLOCK_RE.exec(rest);
	}

	// A dangling open block (close tag not yet streamed / never emitted): the
	// remainder after the open tag is reasoning.
	const openMatch = OPEN_TAIL_RE.exec(rest);
	if (openMatch) {
		// Leading text may still carry orphan tags (e.g. a stray `</think>`).
		pushText(blocks, openMatch.input.slice(0, openMatch.index).replace(ORPHAN_TAG_RE, ""));
		pushThinking(blocks, (openMatch[2] ?? "").replace(ORPHAN_TAG_RE, ""));
	} else {
		// Strip any orphan tags from the trailing text.
		pushText(blocks, rest.replace(ORPHAN_TAG_RE, ""));
	}

	// All-empty (e.g. `<think></think>`) collapses to a single empty text block
	// so the message never becomes contentless.
	return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
}

function isSignedThinking(block: Block): block is ThinkingBlock {
	return (
		block.type === "thinking" &&
		typeof block.thinkingSignature === "string" &&
		block.thinkingSignature.length > 0
	);
}

/**
 * Providers can stream visible text before their native reasoning channel. Pi
 * preserves arrival order, which leaves a signed thinking block below the
 * answer. Move signed provider reasoning ahead of text within each contiguous
 * assistant segment, but never across tool calls or other structural blocks.
 */
function normalizeThinkingOrder(content: Block[]): Block[] {
	let normalized: Block[] | undefined;
	let segmentStart = 0;

	const normalizeSegment = (end: number): void => {
		const segment = content.slice(segmentStart, end);
		const firstText = segment.findIndex((block) => block.type === "text");
		const hasLateThinking = segment.some(
			(block, index) => index > firstText && firstText >= 0 && isSignedThinking(block),
		);
		if (!hasLateThinking) {
			if (normalized) normalized.push(...segment);
			return;
		}

		normalized ??= content.slice(0, segmentStart);
		normalized.push(
			...segment.filter(isSignedThinking),
			...segment.filter((block) => !isSignedThinking(block)),
		);
	};

	for (let index = 0; index <= content.length; index++) {
		const block = content[index];
		if (block && (block.type === "text" || block.type === "thinking")) continue;

		normalizeSegment(index);
		if (normalized && block) normalized.push(block);
		segmentStart = index + 1;
	}

	return normalized ?? content;
}

// Export for testing
export { normalizeThinkingOrder, splitThinking, stripPartialTailTag };

export default function thinkingExtension(pi: ExtensionAPI) {
	// Live conversion during streaming: rebuild the event's message so a native
	// thinking block appears as soon as the open tag streams in, token by token.
	pi.on("message_update", (event) => {
		const ev = event as {
			message?: Msg;
			assistantMessageEvent?: { type?: string };
		};
		const msg = ev.message;
		if (msg?.role !== "assistant" || !Array.isArray(msg.content)) return;

		const streamType = ev.assistantMessageEvent?.type;
		if (streamType && !streamType.startsWith("text_") && !streamType.startsWith("thinking_"))
			return;

		const content = msg.content.flatMap((block): Block[] => {
			if (block.type !== "text") return [block];
			const tb = block as TextBlock;
			if (typeof tb.text !== "string" || !tb.text.includes("<")) return [block];
			// Strip a half-streamed tag so it never flashes as literal text.
			const stripped = stripPartialTailTag(tb.text);
			// Nothing reasoning-related: leave unrelated "<" text alone entirely.
			if (!hasReasoningTag(stripped) && stripped === tb.text) return [block];
			// New objects — never mutate the provider's accumulating block.
			return splitThinking(stripped);
		});
		msg.content = normalizeThinkingOrder(content);
	});

	pi.on("message_end", (event) => {
		const msg = (event as { message?: Msg }).message;
		if (msg?.role !== "assistant" || !Array.isArray(msg.content)) return;

		let changed = false;
		const splitContent = msg.content.flatMap((block): Block[] => {
			if (block.type !== "text") return [block];
			const tb = block as TextBlock;
			if (typeof tb.text !== "string") return [block];
			if (!hasReasoningTag(tb.text)) return [block];
			changed = true;
			return splitThinking(tb.text);
		});
		const content = normalizeThinkingOrder(splitContent);
		changed ||= content !== splitContent;

		// Return the replacement so the native thinking blocks are persisted.
		// Persistence note: this rewrites leaked reasoning from `text` into real
		// `thinking` content blocks, which round-trip to the provider next turn.
		// The blocks carry no thinkingSignature (we never received one — the
		// reasoning leaked into the text channel), so signature-validating APIs
		// may reject or drop them on multi-turn. Accepted trade-off for native
		// dim+italic rendering via the `thinkingText` theme token.
		if (changed) {
			msg.content = content;
			return { message: msg as unknown as never };
		}
	});
}
