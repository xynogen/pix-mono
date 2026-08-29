import { existsSync, readFileSync } from "node:fs";
import type {
	AgentToolUpdateCallback,
	EditToolInput,
	ExtensionContext,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
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
	dotJoin,
	fillToolBackground,
	getTextContent,
	hideCollapsedToolCall,
	isTextContent,
	renderCollapsedToolRow,
	renderToolError,
	setResultDetails,
	termW,
} from "@xynogen/pix-pretty/utils";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";

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

// 1-based file line where `needle` begins post-edit, for absolute diff gutters.
// 0 = file unreadable or needle not found (renderer falls back to relative).
// Duplicate identical edits collapse to the first match — acceptable.
function opEditLine(filePath: string, needle: string): number {
	try {
		if (!filePath || !existsSync(filePath)) return 0;
		const f = readFileSync(filePath, "utf-8");
		const idx = f.indexOf(needle);
		return idx >= 0 ? f.slice(0, idx).split("\n").length : 0;
	} catch {
		return 0;
	}
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
		renderShell: "self",

		async execute(
			tid: string,
			params: EditParams,
			sig: AbortSignal | undefined,
			upd: AgentToolUpdateCallback<unknown> | undefined,
			toolCtx: ExtensionContext,
		) {
			const fp = params.path ?? params.file_path ?? "";
			const operations = getEditOperations(params);
			const fileLang = lang(fp);

			let result: ToolResultLike;
			try {
				result = (await origEdit.execute(
					tid,
					// SAFETY: EditParams preserves the built-in edit schema and only adds legacy aliases.
					params as unknown as Parameters<typeof origEdit.execute>[1],
					sig,
					upd,
					toolCtx,
				)) as ToolResultLike;
			} catch (error) {
				const text = error instanceof Error ? error.message : String(error);
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
					editLine: opEditLine(fp, op0.newText),
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
					editLine: opEditLine(fp, op.newText),
				})),
			});
			return result;
		},

		renderCall(args: EditParams, theme: ThemeLike, renderCtx: RenderContextLike<EditRenderState>) {
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
			const hdr = `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("dim", sp(fp))}`;

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
			const text = renderCtx.lastComponent ?? new TextComponent("", 0, 0);
			const d = result.details as Record<string, unknown> | undefined;
			const isPartial = _opt?.isPartial === true;
			const structuredError =
				renderCtx.isError && (d?._type === "editInfo" || d?._type === "multiEditInfo");
			if (renderCtx.isError && (!structuredError || isPartial)) {
				text.setText(renderToolError(getTextContent(result) || "Error", theme));
				return text;
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
				return text;
			}

			// Single edit — full split diff
			if (d?._type === "editInfo") {
				const key = `ed:${diffThemeCacheKey(theme)}:${termW()}:${d.summary}:${(d.oldContent as string).length}:${(d.newContent as string).length}:${d.language ?? ""}`;
				if (renderCtx.toolCallId) trackInvalidator(renderCtx.toolCallId, renderCtx.invalidate);
				if (renderCtx.state._edk !== key) {
					renderCtx.state._edk = key;
					// ponytail: call already shows `edit <file> <summary>`; don't repeat summary+loc header — gutter carries absolute line
					renderCtx.state._edt = theme.fg("muted", "  rendering diff…");
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
							renderCtx.state._edt = `  ${d.summary}`;
							renderCtx.invalidate();
						});
				}
				text.setText(renderCtx.state._edt ?? `  ${d.summary}`);
				return text;
			}

			// Multi-edit — stacked diffs
			if (d?._type === "multiEditInfo") {
				const key = `med:${diffThemeCacheKey(theme)}:${termW()}:${d.summary}:${d.editCount}:${d.diffLineCount}`;
				if (renderCtx.toolCallId) trackInvalidator(renderCtx.toolCallId, renderCtx.invalidate);
				if (renderCtx.state._edk !== key) {
					renderCtx.state._edk = key;
					// ponytail: call already shows summary; render diffs directly
					renderCtx.state._edt = theme.fg("muted", "  rendering diff…");
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
							const body = rendered.join(`\n${theme.fg("muted", "  ···")}\n`);
							renderCtx.state._edt = body;
							renderCtx.invalidate();
						})
						.catch(() => {
							if (renderCtx.state._edk !== key) return;
							renderCtx.state._edt = `  ${d.editCount} edits ${d.summary}`;
							renderCtx.invalidate();
						});
				}
				text.setText(renderCtx.state._edt ?? `  ${d.editCount} edits ${d.summary}`);
				return text;
			}

			const fallback = result.content?.[0];
			const fallbackText = fallback && isTextContent(fallback) ? fallback.text : "edited";
			text.setText(fillToolBackground(`  ${theme.fg("dim", String(fallbackText).slice(0, 120))}`));
			return text;
		},
	});
}
