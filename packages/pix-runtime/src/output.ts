import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "./host.ts";
import { truncateStringToBytes } from "./utf8.ts";

/**
 * Head-truncate tool output to Pi's limits (2000 lines / 50KB). When one line exceeds the
 * byte cap (minified JSON, a base64 blob), truncateHead keeps nothing; keep its first
 * maxBytes instead, cut on a UTF-8 boundary.
 */
export function truncateOutput(
	text: string,
	maxLines = DEFAULT_MAX_LINES,
	maxBytes = DEFAULT_MAX_BYTES,
): { text: string; truncated: boolean } {
	const r = truncateHead(text, { maxLines, maxBytes });
	if (!r.firstLineExceedsLimit) return { text: r.content, truncated: r.truncated };
	return { text: truncateStringToBytes(text, maxBytes), truncated: true };
}
