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
