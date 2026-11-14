import {
	formatCallTargets,
	resolveBatchStrings,
	runBatchTool,
	withOptionalStringArray,
} from "@xynogen/pix-pretty/batch";
import type { ToolContext } from "@xynogen/pix-pretty/context";
import { BODY_PAD, fadeRulePaint, ruleFrame } from "@xynogen/pix-pretty/frame";
import { renderTitle } from "@xynogen/pix-pretty/render-row";
import { renderTree } from "@xynogen/pix-pretty/renderers";
import { getTextContent, setResultDetails } from "@xynogen/pix-pretty/result";
import { toolCallRenderer, toolCardRenderer } from "@xynogen/pix-pretty/tool-card";
import type { LsParams, PiPrettyApi, ToolFactory, ToolResultLike } from "@xynogen/pix-pretty/types";
import { fillToolBackground } from "@xynogen/pix-pretty/utils";
import type {
	AgentToolUpdateCallback,
	ExtensionContext,
	LsToolInput,
} from "@xynogen/pix-runtime/host";

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

			// No path: list cwd with the single-result shape.
			const targets = resolveBatchStrings(params.path, params.paths);
			const outcome = await runBatchTool<ToolResultLike>({
				targets: targets.length ? targets : [cwd],
				signal: sig,
				nouns: ENTRY_NOUNS,
				maxUnits: params.limit,
				run: (path, i) => runOne(path, i === undefined ? tid : `${tid}:${i}`),
				singleError: (path, text) => ({
					content: [{ type: "text" as const, text }],
					details: { _type: "lsResult" as const, text, path, entryCount: 0 },
					isError: true,
				}),
				section: (result) => {
					const details = result.details as { _type?: string; text?: string; entryCount?: number };
					if (details?._type === "lsResult")
						return { body: details.text ?? "", units: details.entryCount ?? 0 };
					const body = getTextContent(result);
					return { body, units: body.trim().split("\n").filter(Boolean).length };
				},
			});
			if ("single" in outcome) return outcome.single;
			const { text, full, units } = outcome.batch;
			return {
				content: [{ type: "text" as const, text }],
				details: {
					_type: "lsResult" as const,
					text: full,
					path: outcome.batch.targets.join(", "),
					paths: outcome.batch.targets,
					entryCount: units,
				},
			};
		},

		renderCall: toolCallRenderer<LsBatchParams>(TextComponent, (args, theme, renderCtx) => {
			const batchPaths = resolveBatchStrings(args.path, args.paths);
			const fp =
				batchPaths.length > 1
					? formatCallTargets(batchPaths.map(sp), 3, "dirs")
					: (args.path ?? ".");
			return fillToolBackground(
				`${renderTitle(theme, "ls", renderCtx)} ${theme.fg("dim", sp(fp))}`,
			);
		}),

		renderResult: toolCardRenderer<Record<string, unknown>>(TextComponent, {
			name: "ls",
			owns: (d) => d?._type === "lsResult",
			collapsed: (d) => ({
				summary: d?._type === "lsResult" ? `${d.entryCount} entries` : "listed",
				target:
					d?._type === "lsResult" && Array.isArray(d.paths)
						? formatCallTargets((d.paths as string[]).map(sp), 3, "dirs")
						: d?._type === "lsResult"
							? sp(String(d.path ?? "."))
							: ".",
			}),
			body({ d, result, text, theme, ctx: renderCtx, isPartial }) {
				const framed = (lines: string[]) => {
					// One framed box, rules in status color; the count stays in the collapsed row.
					const paint = fadeRulePaint(theme, "success");
					const out = isPartial ? lines : ruleFrame(lines, [], undefined, paint);
					text.setText(fillToolBackground(out.join("\n")));
					return "framed" as const;
				};
				// Batch text is already `===== dir =====` sections, not one tree: a dim block.
				if (d?._type === "lsResult" && Array.isArray(d.paths))
					return framed(String(d.text ?? d.path).split("\n"));
				if (d?._type === "lsResult" && d.text)
					return framed(
						renderTree(d.text as string, d.path as string, theme, renderCtx).split("\n"),
					);
				const output = getTextContent(result) || "listed";
				text.setText(fillToolBackground(`${BODY_PAD}${theme.fg("dim", output.slice(0, 120))}`));
				return undefined;
			},
		}),
	});
}
