import type {
	AgentToolUpdateCallback,
	ExtensionContext,
	LsToolInput,
} from "@earendil-works/pi-coding-agent";
import { resolveBaseBackground } from "@xynogen/pix-pretty/ansi";
import {
	BATCH_MAX_BYTES,
	type BatchSection,
	capSections,
	formatBatchIndex,
	formatCallTargets,
	joinSectionBodies,
	resolveBatchStrings,
	sliceBatchTargets,
	withOptionalStringArray,
} from "@xynogen/pix-pretty/batch";
import type { ToolContext } from "@xynogen/pix-pretty/context";
import { renderTree } from "@xynogen/pix-pretty/renderers";
import type {
	LsParams,
	PiPrettyApi,
	RenderContextLike,
	ThemeLike,
	ToolFactory,
	ToolResultLike,
} from "@xynogen/pix-pretty/types";
import {
	fillToolBackground,
	frameToolResult,
	getErrorMessage,
	getTextContent,
	hideCollapsedToolCall,
	renderCollapsedToolRow,
	renderToolError,
	ruleFrame,
	setResultDetails,
	unframeToolResult,
} from "@xynogen/pix-pretty/utils";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";

export const DEFAULT_LS_LIMIT = 200;

const ENTRY_NOUNS = ["entry", "entries"] as const;

/** LsParams plus the optional batch `paths` array (added to the schema at runtime). */
type LsBatchParams = LsParams & { paths?: string[] };

export function applyLsDefaults(params: LsParams): LsParams {
	return params.limit === undefined ? { ...params, limit: DEFAULT_LS_LIMIT } : params;
}

export function registerLsTool(
	pi: PiPrettyApi,
	createLsTool: ToolFactory<LsToolInput>,
	ctx: ToolContext,
): void {
	const { cwd, sp, TextComponent } = ctx;
	const origLs = createLsTool(cwd);

	pi.registerTool({
		...origLs,
		name: "ls",
		description:
			"List a directory, including dotfiles. Defaults to 200 sorted entries; use limit to request more. Output remains capped by Pi's 50KB hard limit. Pass `paths` to list several known directories in one call.",
		parameters: withOptionalStringArray(
			origLs.parameters,
			"paths",
			"Known directories to list in one call (each capped, one combined result). Use instead of `path` for multiple known directories.",
			["path"],
		),
		renderShell: "self",

		async execute(
			tid: string,
			params: LsBatchParams,
			sig: AbortSignal | undefined,
			upd: AgentToolUpdateCallback<unknown> | undefined,
			toolCtx: ExtensionContext,
		) {
			const runOne = async (path: string, callId: string): Promise<ToolResultLike> => {
				const { paths: _paths, ...rest } = params;
				const effectiveParams = applyLsDefaults({ ...rest, path });
				const fp = effectiveParams.path ?? cwd;
				const result = (await origLs.execute(
					callId,
					effectiveParams,
					sig,
					upd,
					toolCtx,
				)) as ToolResultLike;
				const textContent = getTextContent(result);
				setResultDetails(result, {
					_type: "lsResult",
					text: textContent ?? "",
					path: fp,
					entryCount: textContent ? textContent.trim().split("\n").filter(Boolean).length : 0,
				});
				return result;
			};

			const { targets, omitted } = sliceBatchTargets(
				resolveBatchStrings(params.path, params.paths),
			);

			// Single directory (or default cwd) → preserve the original single result shape.
			if (targets.length <= 1 && omitted === 0) {
				const fp = targets[0] ?? params.path ?? cwd;
				try {
					return await runOne(targets[0] ?? params.path ?? cwd, tid);
				} catch (error) {
					const text = getErrorMessage(error);
					if (sig?.aborted || /aborted/i.test(text)) throw error;
					return {
						content: [{ type: "text" as const, text }],
						details: { _type: "lsResult" as const, text, path: fp, entryCount: 0 },
						isError: true,
					};
				}
			}

			// Batch: list every directory in parallel, cap the combined output.
			const settled = await Promise.all(
				targets.map(async (path, i) => {
					try {
						return { path, result: await runOne(path, `${tid}:${i}`) };
					} catch (error) {
						if (sig?.aborted) throw error;
						return { path, error: getErrorMessage(error) };
					}
				}),
			);
			const sections: BatchSection[] = settled.map((entry) => {
				if ("error" in entry && entry.error) {
					return { id: entry.path, body: "", units: 0, nouns: ENTRY_NOUNS, error: entry.error };
				}
				const result = (entry as { result: ToolResultLike }).result;
				const details = result.details as { _type?: string; text?: string; entryCount?: number };
				const body = details?._type === "lsResult" ? (details.text ?? "") : getTextContent(result);
				const units =
					details?._type === "lsResult"
						? (details.entryCount ?? 0)
						: body.trim().split("\n").filter(Boolean).length;
				return { id: entry.path, body, units, nouns: ENTRY_NOUNS };
			});
			const { text } = capSections(sections, BATCH_MAX_BYTES, params.limit, omitted);
			const entryCount = sections.reduce((sum, s) => sum + (s.error ? 0 : s.units), 0);
			const full = [formatBatchIndex(sections, omitted), joinSectionBodies(sections)]
				.filter(Boolean)
				.join("\n\n");
			return {
				content: [{ type: "text" as const, text }],
				details: {
					_type: "lsResult" as const,
					text: full,
					path: targets.join(", "),
					paths: targets,
					entryCount,
				},
			};
		},

		renderCall(args: LsBatchParams, theme: ThemeLike, renderCtx: RenderContextLike) {
			resolveBaseBackground(theme);
			const batchPaths = resolveBatchStrings(args.path, args.paths);
			const fp =
				batchPaths.length > 1
					? formatCallTargets(batchPaths.map(sp), 3, "dirs")
					: (args.path ?? ".");
			const text = renderCtx.lastComponent ?? new TextComponent("", 0, 0);
			if (
				hideCollapsedToolCall(renderCtx.state as CollapseState, renderCtx.expanded, (value) =>
					text.setText(value),
				)
			)
				return text;
			text.setText(
				fillToolBackground(`${theme.fg("toolTitle", theme.bold("ls"))} ${theme.fg("dim", sp(fp))}`),
			);
			return text;
		},

		renderResult(
			result: ToolResultLike,
			_opt: unknown,
			theme: ThemeLike,
			renderCtx: RenderContextLike,
		) {
			resolveBaseBackground(theme);
			const text = unframeToolResult(renderCtx.lastComponent ?? new TextComponent("", 0, 0));
			const d = result.details as Record<string, unknown> | undefined;
			const isPartial = (_opt as { isPartial?: boolean } | undefined)?.isPartial === true;
			const completed = () => frameToolResult(text, theme, renderCtx.isError);
			const structuredError = renderCtx.isError && d?._type === "lsResult";

			if (renderCtx.isError && (!structuredError || isPartial)) {
				text.setText(renderToolError(getTextContent(result) || "Error", theme));
				return isPartial ? text : completed();
			}

			// Auto-collapse: show summary line after delay
			const cs = renderCtx.state as CollapseState;
			if (!isPartial && tickCollapse("ls", cs, renderCtx.invalidate, renderCtx.expanded)) {
				const isBatch = d?._type === "lsResult" && Array.isArray(d.paths);
				const summary = d?._type === "lsResult" ? `${d.entryCount} entries` : "listed";
				const target =
					isBatch && Array.isArray(d?.paths)
						? formatCallTargets((d.paths as string[]).map(sp), 3, "dirs")
						: d?._type === "lsResult"
							? sp(String(d.path ?? "."))
							: ".";
				text.setText(
					renderCollapsedToolRow(
						theme,
						"ls",
						target,
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
			if (d?._type === "lsResult" && Array.isArray(d.paths)) {
				// Batch: text is already `===== dir =====` section blocks, not a single
				// tree — render as a dim framed block, no per-tree icon layout.
				const paint = (s: string) => theme.fg(renderCtx.isError ? "error" : "success", s);
				const lines = String(d.text ?? d.path).split("\n");
				const out = isPartial ? lines : ruleFrame(lines, [], undefined, paint);
				text.setText(fillToolBackground(out.join("\n")));
				return text;
			}
			if (d?._type === "lsResult" && d.text) {
				// One shape regardless of entry count: a single framed box, no floating
				// "N entries" header (the collapsed row already carries the count).
				// Rules follow status color like bash — green ok, red error. Color can
				// encode status but not the count, so the count stays in the collapsed row.
				const tree = renderTree(d.text as string, d.path as string, theme);
				const paint = (s: string) => theme.fg(renderCtx.isError ? "error" : "success", s);
				const lines = tree.split("\n");
				const out = isPartial ? lines : ruleFrame(lines, [], undefined, paint);
				text.setText(fillToolBackground(out.join("\n")));
				return text;
			}

			const output = getTextContent(result) || "listed";
			text.setText(fillToolBackground(theme.fg("dim", output.slice(0, 120))));
			return isPartial ? text : completed();
		},
	});
}
