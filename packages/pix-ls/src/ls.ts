import type {
	AgentToolUpdateCallback,
	ExtensionContext,
	LsToolInput,
} from "@earendil-works/pi-coding-agent";
import { FG_DIM, RST, resolveBaseBackground } from "@xynogen/pix-pretty/ansi";
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
	getTextContent,
	hideCollapsedToolCall,
	renderCollapsedToolRow,
	renderToolError,
	ruleFrame,
	setResultDetails,
} from "@xynogen/pix-pretty/utils";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";

export const DEFAULT_LS_LIMIT = 200;

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
			"List a directory, including dotfiles. Defaults to 200 sorted entries; use limit to request more. Output remains capped by Pi's 50KB hard limit.",
		renderShell: "self",

		async execute(
			tid: string,
			params: LsParams,
			sig: AbortSignal | undefined,
			upd: AgentToolUpdateCallback<unknown> | undefined,
			toolCtx: ExtensionContext,
		) {
			const effectiveParams = applyLsDefaults(params);
			const fp = effectiveParams.path ?? cwd;
			try {
				const result = (await origLs.execute(
					tid,
					effectiveParams,
					sig,
					upd,
					toolCtx,
				)) as ToolResultLike;
				const textContent = getTextContent(result);
				const entryCount = textContent ? textContent.trim().split("\n").filter(Boolean).length : 0;

				setResultDetails(result, {
					_type: "lsResult",
					text: textContent ?? "",
					path: fp,
					entryCount,
				});

				return result;
			} catch (error) {
				const text = error instanceof Error ? error.message : String(error);
				if (sig?.aborted || /aborted/i.test(text)) throw error;
				return {
					content: [{ type: "text" as const, text }],
					details: { _type: "lsResult" as const, text, path: fp, entryCount: 0 },
					isError: true,
				};
			}
		},

		renderCall(args: LsParams, theme: ThemeLike, renderCtx: RenderContextLike) {
			resolveBaseBackground(theme);
			const fp = args.path ?? ".";
			const text = renderCtx.lastComponent ?? new TextComponent("", 0, 0);
			if (
				hideCollapsedToolCall(renderCtx.state as CollapseState, renderCtx.expanded, (value) =>
					text.setText(value),
				)
			)
				return text;
			text.setText(
				fillToolBackground(
					`${theme.fg("toolTitle", theme.bold("ls"))} ${theme.fg("accent", sp(fp))}`,
				),
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
			const text = renderCtx.lastComponent ?? new TextComponent("", 0, 0);
			const d = result.details as Record<string, unknown> | undefined;
			const isPartial = (_opt as { isPartial?: boolean } | undefined)?.isPartial === true;
			const structuredError = renderCtx.isError && d?._type === "lsResult";

			if (renderCtx.isError && (!structuredError || isPartial)) {
				text.setText(renderToolError(getTextContent(result) || "Error", theme));
				return text;
			}

			// Auto-collapse: show summary line after delay
			const cs = renderCtx.state as CollapseState;
			if (!isPartial && tickCollapse("ls", cs, renderCtx.invalidate, renderCtx.expanded)) {
				const summary = d?._type === "lsResult" ? `${d.entryCount} entries` : "listed";
				const target = d?._type === "lsResult" ? sp(String(d.path ?? ".")) : ".";
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
				return text;
			}
			if (d?._type === "lsResult" && d.text) {
				const raw = String(d.text).trim();
				const singleLine = raw && !raw.includes("\n");
				if (singleLine && !renderCtx.expanded) {
					text.setText(
						fillToolBackground(
							`  ${FG_DIM}${d.entryCount} entries${RST} · ${theme.fg("dim", raw)}`,
						),
					);
					return text;
				}
				const tree = renderTree(d.text as string, d.path as string, theme);
				const info = `  ${FG_DIM}${d.entryCount} entries${RST}`;
				const out = [info, ...ruleFrame(tree.split("\n"))];
				text.setText(fillToolBackground(out.join("\n")));
				return text;
			}

			const output = getTextContent(result) || "listed";
			text.setText(fillToolBackground(`  ${theme.fg("dim", output.slice(0, 120))}`));
			return text;
		},
	});
}
