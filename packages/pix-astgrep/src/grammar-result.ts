/**
 * grammar-result.ts — turn a non-ok grammar parse outcome into a tool result.
 *
 * Every ast-grep tool that parses a file shares this mapping, so the messages
 * for "grammar declined", "needs install", "unsupported", and engine errors
 * stay identical across tools.
 */

import type { GrammarResult } from "./grammars.ts";

interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: { _type: string; outcome: string; lang: string };
	isError: true;
}

/** Map a non-`ok` grammar outcome to a clear, actionable tool result. */
export function grammarErrorResult(
	outcome: GrammarResult,
	lang: string,
	detailType: string,
): ToolResult {
	const text = messageFor(outcome, lang);
	const status =
		outcome.kind === "needs-install" || outcome.kind === "declined"
			? "needs-grammar"
			: outcome.kind === "unsupported"
				? "unsupported"
				: "error";
	return {
		content: [{ type: "text", text }],
		details: { _type: detailType, outcome: status, lang },
		isError: true,
	};
}

function messageFor(outcome: GrammarResult, lang: string): string {
	switch (outcome.kind) {
		case "needs-install":
			return `${lang} needs grammar ${outcome.pkg}. Retry in an interactive session to approve its installation; no files were searched or changed successfully.`;
		case "declined":
			return `${lang} grammar not installed (${outcome.pkg}). Skipped.`;
		case "unsupported":
			return `Language "${lang}" is not supported by ast-grep.`;
		case "error":
			return `ast-grep error for ${lang}: ${outcome.message}`;
		default:
			return `ast-grep could not parse ${lang}.`;
	}
}
