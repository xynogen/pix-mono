/**
 * tool-result-filter.ts — strip model-guidance text from tool_result content.
 *
 * pi-lens appends diagnostic strings (BLIND WRITE, THRASHING) to tool_result
 * content as guidance for the LLM. These are not useful to the user and clutter
 * the TUI. This module filters them out of content blocks before they render.
 *
 * Patterns are anchored to the start of a paragraph (preceded by \n\n) so we
 * don't accidentally clip real output that happens to contain these strings.
 */

import type { ImageContent, TextContent } from "@xynogen/pix-data/ai";

export type ToolContent = TextContent | ImageContent;

/**
 * Paragraph prefixes that identify model-only guidance injected by pi-lens.
 * Each pattern matches from the start of a \n\n-delimited paragraph.
 */
const MODEL_WARNING_PREFIXES = ["⚠ BLIND WRITE —", "🔴 THRASHING —"] as const;

/**
 * Strip model-guidance paragraphs from a single text block's content.
 * Returns the original string if nothing was removed.
 */
export function stripModelWarningParagraphs(text: string): string {
	// Split on double-newline paragraph boundaries, filter out guidance paragraphs,
	// then rejoin. Trim trailing whitespace from the result.
	const paragraphs = text.split(/\n\n/);
	const kept = paragraphs.filter(
		(p) => !MODEL_WARNING_PREFIXES.some((prefix) => p.trimStart().startsWith(prefix)),
	);
	if (kept.length === paragraphs.length) return text;
	return kept.join("\n\n").trimEnd();
}

/**
 * Filter model-guidance warnings from an array of tool content blocks.
 * Returns the original array reference if no blocks were modified.
 */
export function filterModelWarnings(content: ToolContent[]): ToolContent[] {
	let changed = false;
	const result = content.map((block) => {
		if (block.type !== "text") return block;
		const text = (block as TextContent).text;
		if (typeof text !== "string") return block;
		const filtered = stripModelWarningParagraphs(text);
		if (filtered === text) return block;
		changed = true;
		return { ...block, text: filtered } as TextContent;
	});
	return changed ? result : content;
}
