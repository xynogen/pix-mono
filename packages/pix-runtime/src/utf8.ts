import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "./host.ts";

/** Keep the longest prefix that fits a UTF-8 byte budget without splitting a code point. */
export function truncateStringToBytes(value: string, maxBytes: number): string {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
		throw new RangeError("maxBytes must be a non-negative safe integer");
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	const buffer = Buffer.from(value, "utf8");
	let end = maxBytes;
	while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
	return buffer.subarray(0, end).toString("utf8");
}

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
