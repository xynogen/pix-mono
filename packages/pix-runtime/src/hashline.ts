import xxhash from "xxhash-wasm";

// Pi reevaluates shared modules with Jiti. Both tools must share one WASM instance.
const global = globalThis as typeof globalThis & {
	__pixHashline?: {
		initialization?: Promise<void>;
		h32?: (input: string, seed?: number) => number;
	};
};
const state = global.__pixHashline ?? {};
global.__pixHashline = state;

export function initHashline(): Promise<void> {
	state.initialization ??= xxhash()
		.then((hash) => {
			state.h32 = hash.h32;
		})
		.catch((error) => {
			throw new Error("Hashline WASM initialization failed", { cause: error });
		});
	return state.initialization;
}

export function hashLine(text: string): string {
	if (!state.h32) throw new Error("Hashline WASM is not initialized");
	return (state.h32(text, 0) & 0xfff).toString(16).toUpperCase().padStart(3, "0");
}

export function anchor(line: number, text: string): string {
	return `${line}#${hashLine(text)}`;
}

export function parseAnchor(value: unknown): { line: number; hash: string } {
	const match = typeof value === "string" ? /^([1-9]\d*)#([0-9A-F]{3})$/.exec(value) : null;
	if (!match || !Number.isSafeInteger(Number(match[1])))
		throw new Error(`Invalid anchor: ${String(value)}`);
	return { line: Number(match[1]), hash: match[2]! };
}

export type SourceLine = { text: string; ending: string };

export function decodeLines(bytes: Uint8Array): {
	bom: string;
	lines: SourceLine[];
	delimiter: string;
	finalNewline: boolean;
} {
	const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	if (decoded.includes("\0")) throw new Error("Unsupported binary text: NUL byte");
	const bom = decoded.startsWith("\uFEFF") ? "\uFEFF" : "";
	const text = decoded.slice(bom.length);
	const lines: SourceLine[] = [];
	const counts = new Map<string, number>();
	let start = 0;
	for (const match of text.matchAll(/\r\n|\r|\n/g)) {
		const ending = match[0];
		lines.push({ text: text.slice(start, match.index), ending });
		counts.set(ending, (counts.get(ending) ?? 0) + 1);
		start = match.index + ending.length;
	}
	if (start < text.length) lines.push({ text: text.slice(start), ending: "" });
	let delimiter = "\n";
	let highest = 0;
	for (const [ending, count] of counts) {
		if (count > highest) {
			delimiter = ending;
			highest = count;
		}
	}
	return { bom, lines, delimiter, finalNewline: lines.length > 0 && lines.at(-1)!.ending !== "" };
}
