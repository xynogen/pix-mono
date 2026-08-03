/**
 * Tests for leaked-reasoning splitting into native content blocks.
 *
 * splitThinking() turns leaked `<think>`/`<thinking>` spans into real
 * `thinking` content blocks (rendered dim + italic by pi's native
 * `thinkingText` styling) while keeping surrounding answer text as `text`
 * blocks.
 */

import { describe, expect, it } from "bun:test";
import { normalizeThinkingOrder, splitThinking, stripPartialTailTag } from "../src/thinking.js";

type Block = { type: string; text?: string; thinking?: string };

function texts(blocks: Block[]): string[] {
	return blocks.filter((b) => b.type === "text").map((b) => b.text ?? "");
}
function thinkings(blocks: Block[]): string[] {
	return blocks.filter((b) => b.type === "thinking").map((b) => b.thinking ?? "");
}

describe("normalizeThinkingOrder", () => {
	it("moves provider-native thinking before text when reasoning arrives late", () => {
		const text = { type: "text", text: "Visible answer" };
		const thinking = {
			type: "thinking",
			thinking: "Late reasoning",
			thinkingSignature: "reasoning_content",
		};

		expect(normalizeThinkingOrder([text, thinking])).toEqual([thinking, text]);
	});

	it("does not move thinking across a tool call", () => {
		const before = { type: "text", text: "Before tool" };
		const tool = { type: "toolCall", id: "call-1" };
		const after = { type: "text", text: "After tool" };
		const thinking = {
			type: "thinking",
			thinking: "Next segment reasoning",
			thinkingSignature: "reasoning_content",
		};

		expect(normalizeThinkingOrder([before, tool, after, thinking])).toEqual([
			before,
			tool,
			thinking,
			after,
		]);
	});

	it("keeps an already-correct segment unchanged", () => {
		const thinking = { type: "thinking", thinking: "Reasoning" };
		const text = { type: "text", text: "Answer" };
		const blocks = [thinking, text];

		expect(normalizeThinkingOrder(blocks)).toBe(blocks);
	});
});

describe("splitThinking", () => {
	describe("closed thinking blocks", () => {
		it("turns a <thinking> span into a thinking block", () => {
			const out = splitThinking("<thinking>This is reasoning</thinking>");
			expect(out).toEqual([{ type: "thinking", thinking: "This is reasoning" }]);
		});

		it("turns a <think> span into a thinking block", () => {
			const out = splitThinking("<think>This is reasoning</think>");
			expect(out).toEqual([{ type: "thinking", thinking: "This is reasoning" }]);
		});

		it("preserves multi-line reasoning inside one thinking block", () => {
			const out = splitThinking("<thinking>Line 1\nLine 2\nLine 3</thinking>");
			expect(out).toEqual([{ type: "thinking", thinking: "Line 1\nLine 2\nLine 3" }]);
		});

		it("emits one thinking block per closed span in order", () => {
			const out = splitThinking(
				"<thinking>First block</thinking> Some text <thinking>Second block</thinking>",
			);
			expect(thinkings(out)).toEqual(["First block", "Second block"]);
			expect(texts(out)).toEqual(["Some text"]);
		});

		it("drops empty thinking spans", () => {
			const out = splitThinking("Before <thinking></thinking> After");
			expect(thinkings(out)).toEqual([]);
			expect(texts(out).join(" ")).toContain("Before");
			expect(texts(out).join(" ")).toContain("After");
		});

		it("drops whitespace-only thinking spans", () => {
			const out = splitThinking("Before <thinking>   \n  </thinking> After");
			expect(thinkings(out)).toEqual([]);
		});

		it("trims whitespace from thinking content", () => {
			const out = splitThinking("<thinking>\n  This is reasoning  \n</thinking>");
			expect(out).toEqual([{ type: "thinking", thinking: "This is reasoning" }]);
		});

		it("handles mixed case tag names", () => {
			const out = splitThinking("<THINKING>uppercase</THINKING> <ThInKiNg>mixedcase</ThInKiNg>");
			expect(thinkings(out)).toEqual(["uppercase", "mixedcase"]);
		});
	});

	describe("dangling/unclosed blocks", () => {
		it("treats a trailing <thinking> as a thinking block", () => {
			const out = splitThinking("Some text <thinking>Reasoning without close");
			expect(texts(out)).toEqual(["Some text"]);
			expect(thinkings(out)).toEqual(["Reasoning without close"]);
		});

		it("treats a trailing <think> as a thinking block", () => {
			const out = splitThinking("Some text <think>Reasoning without close");
			expect(texts(out)).toEqual(["Some text"]);
			expect(thinkings(out)).toEqual(["Reasoning without close"]);
		});

		it("captures the remainder of a leading unclosed tag as reasoning", () => {
			const out = splitThinking("<thinking>Unclosed\nMore text after");
			expect(thinkings(out)).toEqual(["Unclosed\nMore text after"]);
			expect(texts(out)).toEqual([]);
		});
	});

	describe("orphan tags", () => {
		it("removes orphan closing tags from text", () => {
			const out = splitThinking("Some text </thinking> more text");
			const joined = texts(out).join(" ");
			expect(joined).not.toContain("</thinking>");
			expect(joined).not.toContain("<thinking>");
			expect(joined).toContain("Some text");
			expect(joined).toContain("more text");
		});

		it("treats a trailing open tag as a (possibly empty) reasoning span", () => {
			const out = splitThinking("Text <think> orphan tag");
			expect(texts(out)).toEqual(["Text"]);
			expect(thinkings(out)).toEqual(["orphan tag"]);
		});

		it("handles multiple orphan tags", () => {
			const out = splitThinking("</thinking> text </think> more <thinking> stuff </think>");
			const joined = texts(out).join(" ");
			expect(joined).not.toContain("<thinking>");
			expect(joined).not.toContain("</thinking>");
			expect(joined).not.toContain("</think>");
			expect(joined).toContain("text");
			expect(thinkings(out).join(" ")).toContain("stuff");
		});
	});

	describe("text without thinking tags", () => {
		it("returns the original text block unchanged", () => {
			const input = "This is regular text without any tags";
			expect(splitThinking(input)).toEqual([{ type: "text", text: input }]);
		});

		it("preserves markdown formatting verbatim", () => {
			const input = "# Header\n\n**bold** and *italic*";
			expect(splitThinking(input)).toEqual([{ type: "text", text: input }]);
		});
	});

	describe("mixed content order", () => {
		it("keeps text before a thinking block", () => {
			const out = splitThinking("Response text here\n\n<thinking>reasoning</thinking>");
			expect(out).toEqual([
				{ type: "text", text: "Response text here" },
				{ type: "thinking", thinking: "reasoning" },
			]);
		});

		it("keeps text after a thinking block", () => {
			const out = splitThinking("<thinking>reasoning</thinking>\n\nMore response text");
			expect(out).toEqual([
				{ type: "thinking", thinking: "reasoning" },
				{ type: "text", text: "More response text" },
			]);
		});

		it("keeps text between multiple thinking blocks in order", () => {
			const out = splitThinking(
				"<thinking>first</thinking>\n\nMiddle text\n\n<thinking>second</thinking>",
			);
			expect(out).toEqual([
				{ type: "thinking", thinking: "first" },
				{ type: "text", text: "Middle text" },
				{ type: "thinking", thinking: "second" },
			]);
		});
	});

	describe("streaming (partial tail tags)", () => {
		it("strips a half-streamed opening tag", () => {
			expect(stripPartialTailTag("Hello <thin")).toBe("Hello ");
			expect(stripPartialTailTag("Hello <")).toBe("Hello ");
			expect(stripPartialTailTag("Hello <thinking")).toBe("Hello ");
		});

		it("strips a half-streamed closing tag", () => {
			expect(stripPartialTailTag("reasoning </thinkin")).toBe("reasoning ");
			expect(stripPartialTailTag("reasoning </")).toBe("reasoning ");
		});

		it("keeps non-reasoning partial tags", () => {
			expect(stripPartialTailTag("a generic <div")).toBe("a generic <div");
			expect(stripPartialTailTag("math: 1 < 2")).toBe("math: 1 < 2");
		});

		it("keeps complete tags (only the trailing fragment is stripped)", () => {
			expect(stripPartialTailTag("<thinking>body")).toBe("<thinking>body");
		});

		it("emits a thinking block for an open span before the close arrives", () => {
			const midStream = "<thinking>I am reasoning about";
			const out = splitThinking(stripPartialTailTag(midStream));
			expect(out).toEqual([{ type: "thinking", thinking: "I am reasoning about" }]);
		});

		it("renders progressively without flashing a partial close tag", () => {
			const step1 = splitThinking(stripPartialTailTag("<think>step one"));
			const step2 = splitThinking(stripPartialTailTag("<think>step one and two</thi"));
			const step3 = splitThinking(stripPartialTailTag("<think>step one and two</think>\n\nAnswer"));
			expect(step1).toEqual([{ type: "thinking", thinking: "step one" }]);
			expect(step2).toEqual([{ type: "thinking", thinking: "step one and two" }]);
			expect(step3).toEqual([
				{ type: "thinking", thinking: "step one and two" },
				{ type: "text", text: "Answer" },
			]);
		});
	});

	describe("edge cases", () => {
		it("returns a single text block for an empty string", () => {
			expect(splitThinking("")).toEqual([{ type: "text", text: "" }]);
		});

		it("collapses an all-empty reasoning message to one empty text block", () => {
			expect(splitThinking("<thinking></thinking>")).toEqual([{ type: "text", text: "" }]);
		});

		it("handles thinking content with special characters", () => {
			const out = splitThinking("<thinking>Special chars: $@#%^&*()</thinking>");
			expect(thinkings(out)).toEqual(["Special chars: $@#%^&*()"]);
		});

		it("handles thinking content with code-like syntax", () => {
			const out = splitThinking("<thinking>const x = 5;\nreturn x + 1;</thinking>");
			expect(thinkings(out)).toEqual(["const x = 5;\nreturn x + 1;"]);
		});
	});
});
