import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	AgentToolUpdateCallback,
	EditToolInput,
	ExtensionContext,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { resolveBaseBackground } from "@xynogen/pix-pretty/ansi";
import { MAX_RENDER_LINES } from "@xynogen/pix-pretty/config";
import type { ToolContext } from "@xynogen/pix-pretty/context";
import { parseDiff } from "@xynogen/pix-pretty/diff";
import {
	diffThemeCacheKey,
	renderDiffSummary,
	renderSplit,
	resolveDiffColors,
	summarize,
} from "@xynogen/pix-pretty/diff-render";
import { lang } from "@xynogen/pix-pretty/lang";
import type {
	EditOperation,
	EditParams,
	EditRenderState,
	PiPrettyApi,
	RenderContextLike,
	ThemeLike,
	ToolFactory,
	ToolResultLike,
} from "@xynogen/pix-pretty/types";
import {
	BODY_PAD,
	dotJoin,
	fillToolBackground,
	formatToolCallTitle,
	frameToolResult,
	getErrorMessage,
	getTextContent,
	hideCollapsedToolCall,
	isTextContent,
	renderCollapsedToolRow,
	renderToolError,
	setResultDetails,
	termW,
	unframeToolResult,
} from "@xynogen/pix-pretty/utils";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";
import { decodeLines, hashLine, parseAnchor, type SourceLine } from "@xynogen/pix-runtime/hashline";
import { expandHome } from "@xynogen/pix-runtime/paths";
import { Type } from "typebox";

// ── Helpers ────────────────────────────────────────────────────────────

export function getEditOperations(input: EditParams): EditOperation[] {
	if (Array.isArray(input?.edits)) {
		return input.edits
			.map((e) => ({
				oldText:
					typeof e?.oldText === "string"
						? e.oldText
						: typeof e?.old_text === "string"
							? e.old_text
							: "",
				newText:
					typeof e?.newText === "string"
						? e.newText
						: typeof e?.new_text === "string"
							? e.new_text
							: "",
			}))
			.filter((e) => e.oldText && e.oldText !== e.newText);
	}
	const oldText =
		typeof input?.oldText === "string"
			? input.oldText
			: typeof input?.old_text === "string"
				? input.old_text
				: "";
	const newText =
		typeof input?.newText === "string"
			? input.newText
			: typeof input?.new_text === "string"
				? input.new_text
				: "";
	return oldText && oldText !== newText ? [{ oldText, newText }] : [];
}

type HashEdit = {
	op: "replace" | "insert_before" | "insert_after";
	pos: string;
	end?: string;
	lines: string[];
};
type HashParams = { path: string; edits: HashEdit[] };
type ExactParams = { path: string; edits: EditOperation[] };
type EditInput = HashParams | ExactParams;

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
const editSchema = Type.Object(
	{
		path: Type.String({ minLength: 1 }),
		// ponytail: union whole arrays so the schema rejects mixed formats before execution.
		edits: Type.Union(
			[
				Type.Array(
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
				),
				Type.Array(
					Type.Object(
						{
							oldText: Type.String({
								minLength: 1,
								description: "Exact source text. Include enough context to match once.",
							}),
							newText: Type.String({ description: "Replacement text. Empty string deletes." }),
						},
						{ additionalProperties: false },
					),
					{ minItems: 1 },
				),
			],
			{
				description:
					"Use only hash edits or only exact-text edits in this array. Never mix formats.",
			},
		),
	},
	{ additionalProperties: false },
);

export function prepareHashArguments(input: unknown): unknown {
	if (!input || typeof input !== "object" || Array.isArray(input)) return input;
	const args = { ...input } as Record<string, unknown>;
	if (typeof args.edits === "string") args.edits = JSON.parse(args.edits);
	if (args.edits && typeof args.edits === "object" && !Array.isArray(args.edits))
		args.edits = [args.edits];
	return args;
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
	const check = (value: unknown) => {
		const parsed = parseAnchor(value);
		const line = source.lines[parsed.line - 1];
		if (!line) throw new Error(`Anchor out of bounds: ${String(value)}`);
		if (hashLine(line.text) !== parsed.hash)
			throw new Error(`Stale anchor: ${String(value)}. Read the file again.`);
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
	return { content: source.bom + output.map((line) => line.text + line.ending).join(""), ops };
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
	for (const range of ranges) {
		if (range.start < offset) throw new Error("Overlapping exact-text edits");
		content += original.slice(offset, range.start);
		ops.push({
			oldText: range.oldText,
			newText: range.newText,
			editLine: (content.match(/\r\n|\r|\n/g)?.length ?? 0) + 1,
		});
		content += range.newText;
		offset = range.end;
	}
	return { content: source.bom + content + original.slice(offset), ops };
}

export function summarizeEditOperations(operations: EditOperation[]) {
	const diffs = operations.map((e) => parseDiff(e.oldText, e.newText));
	const totalAdded = diffs.reduce((sum, d) => sum + d.added, 0);
	const totalRemoved = diffs.reduce((sum, d) => sum + d.removed, 0);
	return {
		diffs,
		totalAdded,
		totalRemoved,
		summary: summarize(totalAdded, totalRemoved),
	};
}

// ── Tool ───────────────────────────────────────────────────────────────

export function registerEditTool(
	pi: PiPrettyApi,
	createEditTool: ToolFactory<EditToolInput>,
	ctx: ToolContext,
	trackInvalidator: (id: string, inv: () => void) => void,
): void {
	const { cwd, sp, TextComponent } = ctx;
	const origEdit = createEditTool(cwd);

	pi.registerTool({
		...origEdit,
		name: "edit",
		description:
			"Edit using one format per call: hash anchors {op,pos,end?,lines} or exact text {oldText,newText}. Exact oldText must match once. All edits target the original file and must not overlap. Hash ops: replace, insert_before, insert_after. Empty lines or newText delete. Insertions may touch range boundaries, not interiors. Same-gap inserts follow input order. Use write for empty files or complete rewrites.",
		parameters: editSchema,
		promptSnippet: "Edit with hash anchors or exact text",
		promptGuidelines: [],
		prepareArguments: prepareHashArguments,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		renderShell: "self",

		async execute(
			_tid: string,
			params: EditInput,
			sig: AbortSignal | undefined,
			_upd: AgentToolUpdateCallback<unknown> | undefined,
			toolCtx: ExtensionContext,
		) {
			const fp = typeof params?.path === "string" ? params.path : "";
			let operations: Array<EditOperation & { editLine: number }> = [];
			const fileLang = lang(fp);

			let result: ToolResultLike;
			try {
				if (!fp) throw new Error("path must be a nonempty string");
				const absolutePath = editPath(fp, toolCtx?.cwd || cwd);
				result = await withFileMutationQueue(absolutePath, async () => {
					const abort = () => {
						if (sig?.aborted) throw new Error("Operation aborted");
					};
					abort();
					await access(absolutePath, constants.R_OK | constants.W_OK);
					abort();
					const bytes = await readFile(absolutePath);
					abort();
					const args = prepareHashArguments(params) as EditInput;
					if (!Array.isArray(args.edits) || !args.edits.length)
						throw new Error("edits must be a nonempty array");
					const applied = args.edits.every(
						(edit) => edit && typeof edit === "object" && "oldText" in edit,
					)
						? applyExactEdits(bytes, args as ExactParams)
						: applyHashEdits(bytes, args);
					operations = applied.ops;
					abort();
					// ponytail: in-place writes preserve links and mode, not crash atomicity. Use a separate atomic-write design if needed.
					await writeFile(absolutePath, applied.content, "utf8");
					abort();
					return {
						content: [{ type: "text", text: `Edited ${fp}: ${operations.length} operations.` }],
						details: undefined,
					};
				});
			} catch (error) {
				const text = getErrorMessage(error);
				if (sig?.aborted || /aborted/i.test(text)) throw error;
				return {
					content: [{ type: "text" as const, text }],
					details: {
						_type: "editInfo" as const,
						summary: "failed",
						editLine: 0,
						oldContent: operations[0]?.oldText ?? "",
						newContent: operations[0]?.newText ?? "",
						language: fileLang,
						filePath: fp,
					},
					isError: true,
				};
			}

			if (operations.length === 0) return result;

			const { diffs, summary } = summarizeEditOperations(operations);

			if (operations.length === 1) {
				const op0 = operations[0];
				if (!op0) return result;
				setResultDetails(result, {
					_type: "editInfo",
					summary,
					editLine: op0.editLine,
					oldContent: op0.oldText,
					newContent: op0.newText,
					language: fileLang,
					filePath: fp,
				});
				return result;
			}

			setResultDetails(result, {
				_type: "multiEditInfo",
				summary,
				editCount: operations.length,
				diffLineCount: diffs.reduce((sum, d) => sum + d.lines.length, 0),
				ops: operations.map((op) => ({
					oldContent: op.oldText,
					newContent: op.newText,
					language: fileLang,
					filePath: fp,
					editLine: op.editLine,
				})),
			});
			return result;
		},

		renderCall(
			args: EditParams & Partial<HashParams>,
			theme: ThemeLike,
			renderCtx: RenderContextLike<EditRenderState>,
		) {
			resolveBaseBackground(theme);
			const fp = args?.path ?? args?.file_path ?? "";
			const operations = getEditOperations(args);
			const text = renderCtx.lastComponent ?? new TextComponent("", 0, 0);
			if (
				hideCollapsedToolCall(renderCtx.state as CollapseState, renderCtx.expanded, (value) =>
					text.setText(value),
				)
			)
				return text;
			const hdr = `${formatToolCallTitle(theme, "edit", renderCtx)} ${theme.fg("dim", sp(fp))}`;

			if (Array.isArray(args.edits) && args.edits.some((edit) => "pos" in edit)) {
				text.setText(
					fillToolBackground(dotJoin([hdr, theme.fg("muted", `${args.edits.length} operations`)])),
				);
				return text;
			}
			if (operations.length === 0) {
				text.setText(fillToolBackground(hdr));
				return text;
			}

			const { summary } = summarizeEditOperations(operations);
			const coloredSummary = renderDiffSummary(summary, theme);
			const paint = (s: string) => theme.fg("muted", s);
			const suffix = dotJoin(
				[
					hdr,
					operations.length > 1 && theme.fg("muted", `${operations.length} edits`),
					theme.fg("muted", "estimate"),
					coloredSummary,
				],
				paint,
			);
			text.setText(fillToolBackground(suffix));
			return text;
		},

		renderResult(
			result: ToolResultLike,
			_opt: ToolRenderResultOptions,
			theme: ThemeLike,
			renderCtx: RenderContextLike<EditRenderState>,
		) {
			resolveBaseBackground(theme);
			const text = unframeToolResult(renderCtx.lastComponent ?? new TextComponent("", 0, 0));
			const d = result.details as Record<string, unknown> | undefined;
			const isPartial = _opt?.isPartial === true;
			const completed = () => frameToolResult(text, theme, renderCtx.isError);
			const structuredError =
				renderCtx.isError && (d?._type === "editInfo" || d?._type === "multiEditInfo");
			if (renderCtx.isError && (!structuredError || isPartial)) {
				text.setText(renderToolError(getTextContent(result) || "Error", theme));
				return isPartial ? text : completed();
			}

			// Auto-collapse: show summary line after delay
			const cs = renderCtx.state as CollapseState;
			if (!isPartial && tickCollapse("edit", cs, renderCtx.invalidate, renderCtx.expanded)) {
				const summary =
					d?._type === "editInfo"
						? (d.summary as string)
						: d?._type === "multiEditInfo"
							? dotJoin([`${d.editCount} edits`, String(d.summary)])
							: "edited";
				let filePath = "";
				if (d?._type === "editInfo") filePath = String(d.filePath ?? "");
				else if (d?._type === "multiEditInfo") {
					const ops = d.ops as Array<Record<string, unknown>> | undefined;
					filePath = String(ops?.[0]?.filePath ?? "");
				}
				text.setText(
					renderCollapsedToolRow(
						theme,
						"edit",
						sp(filePath),
						renderCtx.isError ? "failed" : summary,
						renderCtx.isError ? "error" : "success",
					),
				);
				return text;
			}

			if (renderCtx.isError) {
				text.setText(renderToolError(getTextContent(result) || "Error", theme));
				return completed();
			}

			// Single edit — full split diff
			if (d?._type === "editInfo") {
				const key = `ed:${diffThemeCacheKey(theme)}:${termW()}:${d.summary}:${(d.oldContent as string).length}:${(d.newContent as string).length}:${d.language ?? ""}`;
				if (renderCtx.toolCallId) trackInvalidator(renderCtx.toolCallId, renderCtx.invalidate);
				if (renderCtx.state._edk !== key) {
					renderCtx.state._edk = key;
					// ponytail: call already shows `edit <file> <summary>`; don't repeat summary+loc header — gutter carries absolute line
					renderCtx.state._edt = `${BODY_PAD}${theme.fg("muted", "rendering diff…")}`;
					const dc = resolveDiffColors(theme);
					const diff = parseDiff(
						d.oldContent as string,
						d.newContent as string,
						3,
						d.editLine as number,
					);
					renderSplit(diff, d.language as string | undefined, MAX_RENDER_LINES, dc)
						.then((rendered) => {
							if (renderCtx.state._edk !== key) return;
							renderCtx.state._edt = rendered;
							renderCtx.invalidate();
						})
						.catch(() => {
							if (renderCtx.state._edk !== key) return;
							renderCtx.state._edt = `${BODY_PAD}${d.summary}`;
							renderCtx.invalidate();
						});
				}
				text.setText(renderCtx.state._edt ?? `${BODY_PAD}${d.summary}`);
				return isPartial ? text : completed();
			}

			// Multi-edit — stacked diffs
			if (d?._type === "multiEditInfo") {
				const key = `med:${diffThemeCacheKey(theme)}:${termW()}:${d.summary}:${d.editCount}:${d.diffLineCount}`;
				if (renderCtx.toolCallId) trackInvalidator(renderCtx.toolCallId, renderCtx.invalidate);
				if (renderCtx.state._edk !== key) {
					renderCtx.state._edk = key;
					// ponytail: call already shows summary; render diffs directly
					renderCtx.state._edt = `${BODY_PAD}${theme.fg("muted", "rendering diff…")}`;
					const dc = resolveDiffColors(theme);
					Promise.all(
						(
							d.ops as Array<{
								oldContent: string;
								newContent: string;
								language?: string;
								editLine?: number;
							}>
						).map((op) => {
							const diff = parseDiff(op.oldContent, op.newContent, 3, op.editLine ?? 0);
							return renderSplit(diff, op.language, MAX_RENDER_LINES, dc);
						}),
					)
						.then((rendered) => {
							if (renderCtx.state._edk !== key) return;
							const body = rendered.join(`\n${`${BODY_PAD}${theme.fg("muted", "···")}`}\n`);
							renderCtx.state._edt = body;
							renderCtx.invalidate();
						})
						.catch(() => {
							if (renderCtx.state._edk !== key) return;
							renderCtx.state._edt = `${BODY_PAD}${d.editCount} edits ${d.summary}`;
							renderCtx.invalidate();
						});
				}
				text.setText(renderCtx.state._edt ?? `${BODY_PAD}${d.editCount} edits ${d.summary}`);
				return isPartial ? text : completed();
			}

			const fallback = result.content?.[0];
			const fallbackText = fallback && isTextContent(fallback) ? fallback.text : "edited";
			text.setText(
				fillToolBackground(`${BODY_PAD}${theme.fg("dim", String(fallbackText).slice(0, 120))}`),
			);
			return isPartial ? text : completed();
		},
	});
}
