import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateToolArguments } from "@earendil-works/pi-ai";
import {
	type EditOperations,
	truncateHead,
	type WriteOperations,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { anchor, decodeLines, hashLine, parseAnchor, type SourceLine } from "./hashline.ts";
import { expandHome } from "./paths.ts";

type EditOperation = { oldText: string; newText: string };
export const DEFAULT_READ_LIMIT = 400;
const checkAbort = (signal?: AbortSignal) => {
	if (signal?.aborted) throw new Error("Operation aborted");
};
export const localFiles: EditOperations & WriteOperations = {
	readFile,
	access: (path) => access(path, constants.R_OK | constants.W_OK),
	mkdir: async (path) => {
		await mkdir(path, { recursive: true });
	},
	writeFile: (path, content) => writeFile(path, content, "utf8"),
};

type HashEdit = {
	op: "replace" | "insert_before" | "insert_after";
	pos: string;
	end?: string;
	lines: string[];
};
export type HashParams = { path: string; edits: HashEdit[] };
type ExactParams = { path: string; edits: EditOperation[] };
export type EditInput = HashParams | ExactParams;

const hashFields = {
	pos: Type.String({
		pattern: "^[1-9][0-9]*#[0-9A-F]{3}$",
		description: "Original LINE#HASH anchor from read",
	}),
	lines: Type.Array(
		Type.String({
			description:
				"One literal source line per item. No newline or LINE#HASH| prefix. Empty array deletes.",
		}),
	),
};
const hashEdits = Type.Array(
	Type.Union([
		Type.Object(
			{
				op: Type.Literal("replace"),
				...hashFields,
				end: Type.Optional(
					Type.String({
						pattern: "^[1-9][0-9]*#[0-9A-F]{3}$",
						description: "Inclusive end anchor. Omit for one line.",
					}),
				),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				op: Type.Union([Type.Literal("insert_before"), Type.Literal("insert_after")]),
				...hashFields,
			},
			{ additionalProperties: false },
		),
	]),
	{ minItems: 1 },
);
const exactEdits = Type.Array(
	Type.Object(
		{
			oldText: Type.String({
				minLength: 1,
				description:
					"Fallback only after a hash-anchor edit fails. Exact current source text; must match once.",
			}),
			newText: Type.String({ description: "Replacement text. Empty string deletes." }),
		},
		{ additionalProperties: false },
	),
	{ minItems: 1 },
);
const path = Type.String({ minLength: 1 });
export const editSchema = Type.Object(
	{
		path,
		// ponytail: union whole arrays so the schema rejects mixed formats before execution.
		edits: Type.Union([hashEdits, exactEdits], {
			description:
				"Try hash-anchor edits first. Use exact-text edits only after a hash-anchor edit fails. Never mix formats.",
		}),
	},
	{ additionalProperties: false },
);
// One branch each, so a bad call reports only the errors of the format it meant.
const hashSchema = Type.Object({ path, edits: hashEdits }, { additionalProperties: false });
const exactSchema = Type.Object({ path, edits: exactEdits }, { additionalProperties: false });

const parseJson = (value: string): unknown => {
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
};

export function prepareHashArguments(input: unknown): unknown {
	if (!input || typeof input !== "object" || Array.isArray(input)) return input;
	const args = { ...input } as Record<string, unknown>;
	if (typeof args.edits === "string") args.edits = parseJson(args.edits);
	if (args.edits && typeof args.edits === "object" && !Array.isArray(args.edits))
		args.edits = [args.edits];
	// Top recorded failure: one edit item sent as a JSON string.
	if (Array.isArray(args.edits))
		args.edits = args.edits.map((item) => {
			if (typeof item !== "string") return item;
			const parsed = parseJson(item);
			return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : item;
		});
	return args;
}

const EDIT_FIX = "Fix: resend only the broken field; keep one format per call.";

function editFix(format: "hash" | "exact", path: string, problem: string): string {
	if (/\.(pos|end)$/.test(path) && problem.startsWith("expected to match"))
		return "LINE#HASH from read, hash is uppercase hex (12#A3F)";
	if (/\.op$/.test(path)) return "op is replace, insert_before or insert_after";
	if (/\.lines$/.test(path) && problem === "missing")
		return "missing; add lines: [] of literal source lines ([] deletes)";
	if (/\.lines(\.\d+)?$/.test(path)) return "lines is an array of strings, one per line";
	if (/\.oldText$/.test(path) && problem !== "missing")
		return "oldText is non-empty exact current source text";
	if (problem === "unknown field") {
		if (!path.startsWith("edits.")) return "unknown field; send only path and edits";
		return format === "hash"
			? "unknown field; hash items take op, pos, end?, lines"
			: "unknown field; exact items take oldText, newText";
	}
	if (/^edits\.\d+$/.test(path)) return `${problem}; each edit is one object`;
	if (path === "edits") return `${problem}; edits is a non-empty array of objects`;
	return problem;
}

/**
 * Normalize, then check with the host validator. A bad call fails with a few
 * lines that name the field and the fix, for the format the call meant.
 */
export function prepareEditArguments(input: unknown): unknown {
	const args = prepareHashArguments(input);
	const edits = (args as { edits?: unknown } | undefined)?.edits;
	const items = Array.isArray(edits) ? edits : [];
	const kind = (item: unknown) =>
		item && typeof item === "object"
			? ["op", "pos", "end", "lines"].some((k) => k in item)
				? "hash"
				: ["oldText", "newText"].some((k) => k in item)
					? "exact"
					: undefined
			: undefined;
	const kinds = items.map(kind);
	const at = (k: string) => kinds.flatMap((x, i) => (x === k ? [i] : [])).join(",");
	if (kinds.includes("hash") && kinds.includes("exact"))
		throw new Error(
			badArgs(
				"edit",
				[`- edits: mixed formats (hash at [${at("hash")}], exact at [${at("exact")}])`],
				EDIT_FIX,
			),
		);
	const format = kinds.includes("exact") ? "exact" : "hash";
	checkArgs(
		"edit",
		format === "hash" ? hashSchema : exactSchema,
		args,
		(path, problem) => editFix(format, path, problem),
		EDIT_FIX,
	);
	return args;
}

const clip = (text: string, max: number) =>
	text.length > max ? `${text.slice(0, max - 1)}…` : text;

function badArgs(tool: string, rows: string[], footer: string): string {
	const head =
		rows.length > 5 ? `${tool}: ${rows.length} bad arguments, first 5` : `${tool}: bad arguments`;
	return [head, ...rows.slice(0, 5), footer].join("\n");
}

/** Host-validate `args`; on failure throw a short field/fix list, not the full-argument echo. */
function checkArgs(
	tool: string,
	schema: object,
	args: unknown,
	fix: (path: string, problem: string, value: unknown) => string,
	footer: string,
): void {
	try {
		validateToolArguments(
			{ name: tool, description: "", parameters: schema },
			{ type: "toolCall", id: "", name: tool, arguments: args as never },
		);
		return;
	} catch (error) {
		// ponytail: reads pi-ai's "  - path: problem" rows; an unknown format rethrows the host error.
		const text = (error instanceof Error ? error.message : String(error)).split(
			"\n\nReceived arguments:",
		)[0];
		const seen = new Set<string>();
		const rows = [...(text ?? "").matchAll(/^ {2}- (\S+): (.+)$/gm)].map(
			([, path = "", problem = ""]) => {
				const value =
					path === "root"
						? args
						: path
								.split(".")
								.reduce<unknown>(
									(v, k) =>
										v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined,
									args,
								);
				const shown =
					value === undefined ? "" : ` ${clip(JSON.stringify(value) ?? String(value), 40)}`;
				// State a repeated fix once, so five rows stay a few hundred bytes.
				const advice = fix(path, problem, value);
				const said = seen.has(advice);
				seen.add(advice);
				return `- ${path.replace(/\.(\d+)/g, "[$1]")}${shown}: ${said ? "same fix" : advice}`;
			},
		);
		if (!rows.length) throw error;
		throw new Error(badArgs(tool, rows, footer));
	}
}

export function editPath(path: string, cwd: string): string {
	let value = path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ").replace(/^@/, "");
	if (
		process.platform === "win32" &&
		value.startsWith("/") &&
		!value.startsWith("//") &&
		!value.includes("\\")
	) {
		value = value.replace(
			/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i,
			(_all, drive: string, tail: string | undefined) =>
				`${drive.toUpperCase()}:\\${(tail ?? "").replaceAll("/", "\\")}`,
		);
	}
	value = expandHome(value);
	if (value.startsWith("file://")) value = fileURLToPath(value);
	return resolve(cwd, value);
}

function applyHashEdits(bytes: Buffer, input: unknown) {
	const args = prepareHashArguments(input) as HashParams;
	if (
		!args ||
		typeof args.path !== "string" ||
		!args.path ||
		!Array.isArray(args.edits) ||
		!args.edits.length
	)
		throw new Error("Invalid hashline edit input");
	if (Object.keys(args).some((key) => !["path", "edits"].includes(key)))
		throw new Error("Legacy exact-text fields are not supported");
	const source = decodeLines(bytes);
	// Stale/out-of-bounds anchors carry the current lines around the target so the
	// model can retry at once instead of spending a read round-trip.
	const nearby = (line: number) => {
		const from = Math.max(1, Math.min(line, source.lines.length) - 2);
		const rows = source.lines.slice(from - 1, from + 4).map((l, i) => {
			const text = l.text.length > 200 ? `${l.text.slice(0, 200)}…` : l.text;
			return `${anchor(from + i, l.text)}|${text}`;
		});
		return rows.length ? `\nCurrent lines:\n${rows.join("\n")}` : "";
	};
	const check = (value: unknown) => {
		const parsed = parseAnchor(value);
		const line = source.lines[parsed.line - 1];
		if (!line)
			throw new Error(
				`Anchor out of bounds: ${String(value)} (file has ${source.lines.length} lines).${nearby(parsed.line)}`,
			);
		if (hashLine(line.text) !== parsed.hash)
			throw new Error(
				`Stale anchor: ${String(value)}. Use the current anchors below, or read again if the target moved.${nearby(parsed.line)}`,
			);
		return parsed.line;
	};
	const replacements: Array<{ start: number; end: number; lines: string[] }> = [];
	const gaps = new Map<number, string[]>();
	for (const edit of args.edits) {
		if (
			!edit ||
			typeof edit !== "object" ||
			Object.keys(edit).some((key) => !["op", "pos", "end", "lines"].includes(key))
		)
			throw new Error("Legacy or invalid edit fields");
		if (
			!["replace", "insert_before", "insert_after"].includes(edit.op) ||
			!Array.isArray(edit.lines) ||
			edit.lines.some(
				(line) =>
					typeof line !== "string" ||
					/[\r\n\0]|^[1-9]\d*#[0-9A-F]{3}\|/.test(line) ||
					/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(line),
			)
		)
			throw new Error("Invalid edit operation or source lines");
		const start = check(edit.pos);
		if (edit.op === "replace") {
			const end = edit.end === undefined ? start : check(edit.end);
			if (end < start) throw new Error("Reversed replacement range");
			replacements.push({ start, end, lines: edit.lines });
		} else {
			if (edit.end !== undefined) throw new Error("end is only allowed for replace");
			const gap = edit.op === "insert_before" ? start - 1 : start;
			gaps.set(gap, [...(gaps.get(gap) ?? []), ...edit.lines]);
		}
	}
	replacements.sort((a, b) => a.start - b.start);
	for (let i = 0; i < replacements.length; i++) {
		const range = replacements[i]!;
		if (i && replacements[i - 1]!.end >= range.start)
			throw new Error("Overlapping replacement ranges");
		for (const gap of gaps.keys())
			if (gap >= range.start && gap < range.end)
				throw new Error("Insertion overlaps a replacement range");
	}
	const output: SourceLine[] = [];
	// 1-based output line spans each op wrote, for the fresh anchors in the result.
	const spans: Array<[number, number]> = [];
	const ops: Array<EditOperation & { editLine: number }> = [];
	const append = (lines: string[]) =>
		output.push(...lines.map((text) => ({ text, ending: source.delimiter })));
	let rangeIndex = 0;
	for (let gap = 0; gap <= source.lines.length; ) {
		const insertion = gaps.get(gap);
		if (insertion?.length) {
			const context = source.lines[Math.max(0, gap - 1)]!.text;
			ops.push({
				oldText: context,
				newText:
					gap === 0 ? [...insertion, context].join("\n") : [context, ...insertion].join("\n"),
				editLine: Math.max(1, output.length + (gap === 0 ? 1 : 0)),
			});
			spans.push([output.length + 1, output.length + insertion.length]);
			append(insertion);
		}
		if (gap === source.lines.length) break;
		const range = replacements[rangeIndex];
		if (range?.start === gap + 1) {
			ops.push({
				oldText: source.lines
					.slice(gap, range.end)
					.map((line) => line.text)
					.join("\n"),
				newText: range.lines.join("\n"),
				editLine: output.length + 1,
			});
			// A deletion has no new lines; mark the line that now sits in its place.
			spans.push([output.length + 1, output.length + Math.max(1, range.lines.length)]);
			append(range.lines);
			gap = range.end;
			rangeIndex++;
		} else {
			output.push({ ...source.lines[gap]! });
			gap++;
		}
	}
	for (let i = 0; i < output.length; i++) {
		if (i === output.length - 1)
			output[i]!.ending = source.finalNewline ? output[i]!.ending || source.delimiter : "";
		else if (!output[i]!.ending) output[i]!.ending = source.delimiter;
	}
	return {
		content: source.bom + output.map((line) => line.text + line.ending).join(""),
		ops,
		spans,
	};
}

function applyExactEdits(bytes: Buffer, args: ExactParams) {
	if (Object.keys(args).some((key) => !["path", "edits"].includes(key)))
		throw new Error("Invalid exact-text edit fields");
	const source = decodeLines(bytes);
	const original = source.lines.map((line) => line.text + line.ending).join("");
	// ponytail: exact bytes only. Add newline normalization only if callers need it.
	const ranges = args.edits
		.map((edit) => {
			if (
				!edit ||
				typeof edit !== "object" ||
				Object.keys(edit).some((key) => !["oldText", "newText"].includes(key)) ||
				typeof edit.oldText !== "string" ||
				!edit.oldText ||
				typeof edit.newText !== "string" ||
				[edit.oldText, edit.newText].some((text) =>
					/\0|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text),
				)
			)
				throw new Error("Invalid exact-text edit");
			const start = original.indexOf(edit.oldText);
			if (start < 0) throw new Error("oldText was not found. Use exact source text.");
			if (original.indexOf(edit.oldText, start + 1) >= 0)
				throw new Error("oldText matches more than once. Include more context.");
			return { ...edit, start, end: start + edit.oldText.length };
		})
		.sort((a, b) => a.start - b.start);
	let content = "";
	let offset = 0;
	const ops: Array<EditOperation & { editLine: number }> = [];
	const spans: Array<[number, number]> = [];
	const lineCount = (text: string) => text.match(/\r\n|\r|\n/g)?.length ?? 0;
	for (const range of ranges) {
		if (range.start < offset) throw new Error("Overlapping exact-text edits");
		content += original.slice(offset, range.start);
		const editLine = lineCount(content) + 1;
		ops.push({ oldText: range.oldText, newText: range.newText, editLine });
		spans.push([editLine, editLine + lineCount(range.newText)]);
		content += range.newText;
		offset = range.end;
	}
	return { content: source.bom + content + original.slice(offset), ops, spans };
}

/** Context lines around each changed span, and the cap on anchored lines per result. */
const FRESH_CONTEXT = 2;
const FRESH_MAX_LINES = 20;

/**
 * Current `LINE#HASH|text` rows around the changed spans, so a chained edit on
 * the same file needs no `read` between calls (SWE-agent shows the edited
 * window after every edit). Gaps between spans are marked with `…`.
 */
export function freshAnchors(content: string, spans: Array<[number, number]>): string {
	const lines = decodeLines(Buffer.from(content, "utf8")).lines;
	const wanted = new Set<number>();
	for (const [from, to] of spans)
		for (
			let n = Math.max(1, from - FRESH_CONTEXT);
			n <= Math.min(lines.length, to + FRESH_CONTEXT);
			n++
		)
			wanted.add(n);
	const picked = [...wanted].sort((a, b) => a - b);
	const shown = picked.slice(0, FRESH_MAX_LINES);
	const rows: string[] = [];
	for (const [i, n] of shown.entries()) {
		if (i && n !== (shown[i - 1] ?? 0) + 1) rows.push("…");
		const text = lines[n - 1]?.text ?? "";
		rows.push(`${anchor(n, text)}|${text.length > 200 ? `${text.slice(0, 200)}…` : text}`);
	}
	if (picked.length > shown.length)
		rows.push(`… ${picked.length - shown.length} more changed lines; read for anchors`);
	return rows.join("\n");
}

export function readText(bytes: Buffer, offset = 1, limit = DEFAULT_READ_LIMIT) {
	if (!Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(limit) || limit < 1)
		throw new Error("offset and limit must be positive integers");
	const source = decodeLines(bytes);
	if (source.lines.length && offset > source.lines.length)
		throw new Error(`Offset ${offset} is beyond end of file (${source.lines.length} lines total)`);
	const selected = source.lines.slice(offset - 1, offset - 1 + limit);
	const annotated = selected
		.map((line, i) => `${anchor(offset + i, line.text)}|${line.text}`)
		.join("\n");
	let capped = truncateHead(annotated);
	if (offset - 1 + capped.outputLines < source.lines.length) {
		const reserve = Buffer.byteLength(
			`[Read continues at offset=${offset + selected.length}. The next line exceeds the byte limit.]\n\n`,
		);
		capped = truncateHead(annotated, { maxBytes: 50 * 1024 - reserve });
	}
	const count = capped.outputLines;
	const notice =
		offset - 1 + count < source.lines.length
			? `[Read continues at offset=${offset + count}. ${capped.firstLineExceedsLimit ? "The next line exceeds the byte limit." : ""}]`
			: "";
	return {
		content: selected
			.slice(0, count)
			.map((line) => line.text)
			.join("\n"),
		offset,
		lineCount: count,
		modelContent: capped.content,
		notice,
	};
}

export async function writeText(
	path: string,
	content: string,
	ops: WriteOperations = localFiles,
	signal?: AbortSignal,
	key = path,
) {
	if (!path || path.includes("\0"))
		throw new Error("path must be a nonempty string without NUL bytes");
	if (typeof content !== "string") throw new Error("content must be a string");
	return withFileMutationQueue(key, async () => {
		checkAbort(signal);
		await ops.mkdir((ops === localFiles ? dirname : posix.dirname)(path));
		checkAbort(signal);
		await ops.writeFile(path, content);
		checkAbort(signal);
	});
}

export async function editText(
	path: string,
	input: unknown,
	ops: EditOperations = localFiles,
	signal?: AbortSignal,
	key = path,
) {
	const args = prepareEditArguments(input) as EditInput;
	return withFileMutationQueue(key, async () => {
		checkAbort(signal);
		await ops.access(path);
		checkAbort(signal);
		const bytes = await ops.readFile(path);
		checkAbort(signal);
		const applied = args.edits.every((edit) => "oldText" in edit)
			? applyExactEdits(bytes, args as ExactParams)
			: applyHashEdits(bytes, args);
		checkAbort(signal);
		await ops.writeFile(path, applied.content);
		checkAbort(signal);
		return { ...applied, fresh: freshAnchors(applied.content, applied.spans) };
	});
}
