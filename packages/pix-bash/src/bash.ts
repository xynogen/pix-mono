import type {
	AgentToolUpdateCallback,
	BashToolInput,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { truncateToWidth } from "@earendil-works/pi-tui";
import { BG_BASE, FG_DIM, RST, resolveBaseBackground } from "@xynogen/pix-pretty/ansi";
import { MAX_PREVIEW_LINES } from "@xynogen/pix-pretty/config";
import type { ToolContext } from "@xynogen/pix-pretty/context";
import { renderBashOutput } from "@xynogen/pix-pretty/renderers";
import type {
	BashParams,
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
	normalizeLineEndings,
	renderCollapsedToolRow,
	renderToolError,
	ruleFrame,
	setResultDetails,
	termW,
} from "@xynogen/pix-pretty/utils";
import { formatDuration } from "@xynogen/pix-pretty/widget-format";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";

export function summarizeBashCommand(command: string): string {
	const lines = command
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && line !== "set -e" && !line.startsWith("#"));
	const steps = lines
		.flatMap((line) => line.split(/\s*(?:&&|\|\||;)\s*/))
		.map((step) => step.trim())
		.filter(Boolean);

	if (steps.length === 0) return "command";
	const first = steps[0] ?? "command";
	if (/^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=|^(?:if|for|while|case)\b/.test(first)) {
		return dotJoin(["shell script", `${lines.length} lines`]);
	}

	const compact = first.replace(/\s+/g, " ");
	return dotJoin([compact, steps.length > 1 && `+${steps.length - 1} steps`]);
}

// ponytail: thin wrapper keeps old import path; canonical is formatDuration(ms,'bash') in pix-pretty
export function formatBashDuration(durationMs: number): string {
	return formatDuration(durationMs, "bash");
}

export function registerBashTool(
	pi: PiPrettyApi,
	createBashTool: ToolFactory<BashToolInput>,
	ctx: ToolContext,
): void {
	const { cwd, TextComponent, terminalWidth } = ctx;
	const origBash = createBashTool(cwd);

	pi.registerTool({
		...origBash,
		name: "bash",
		// Full-width framing (rules + bg fill) baked at termW(); the default
		// Box shell pads x by 1 and re-wraps at width-2, splitting every line.
		renderShell: "self",

		async execute(
			tid: string,
			params: BashParams,
			sig: AbortSignal | undefined,
			upd: AgentToolUpdateCallback<unknown> | undefined,
			toolCtx: ExtensionContext,
		) {
			const startedAt = Date.now();
			const details = (text: string) => {
				const exitMatch = text.match(/(?:exit code|exited with(?: code)?|exit status)[:\s]*(\d+)/i);
				const exitCode = exitMatch
					? Number(exitMatch[1])
					: text.includes("command not found") || text.includes("No such file")
						? 1
						: 0;
				return {
					_type: "bashResult" as const,
					text,
					exitCode,
					command: params.command ?? "",
					durationMs: Date.now() - startedAt,
				};
			};

			try {
				const result = (await origBash.execute(tid, params, sig, upd, toolCtx)) as ToolResultLike;
				setResultDetails(result, details(getTextContent(result)));
				return result;
			} catch (error) {
				const text = error instanceof Error ? error.message : String(error);
				if (!/(?:exit code|exited with(?: code)?|exit status)[:\s]*(\d+)/i.test(text)) {
					throw error;
				}
				return {
					content: [{ type: "text" as const, text }],
					details: details(text),
					isError: true,
				};
			}
		},

		renderCall(args: BashParams, theme: ThemeLike, renderCtx: RenderContextLike) {
			resolveBaseBackground(theme);
			const cmd = args.command ?? "";
			const displayCmdRaw = cmd.trim();
			const text = renderCtx.lastComponent ?? new TextComponent("", 0, 0);
			const label = theme.fg("toolTitle", theme.bold("bash"));
			const collapseState = renderCtx.state as CollapseState;
			if (hideCollapsedToolCall(collapseState, renderCtx.expanded, (value) => text.setText(value)))
				return text;
			const timeout = args.timeout ? ` ${theme.fg("muted", `(${args.timeout}s timeout)`)}` : "";
			const cmdLines = displayCmdRaw.split("\n");
			const firstLine = cmdLines[0] ?? "";
			const compactCmd =
				cmdLines.length > 1
					? `${firstLine} ${theme.fg("muted", `… (+${cmdLines.length - 1} lines)`)}`
					: firstLine;
			const baseCmd = renderCtx.expanded ? displayCmdRaw : compactCmd;
			const availableWidth = Math.max(1, (terminalWidth?.() ?? termW()) - 1);
			const prefix = `${label} `;
			const reserve = Math.max(0, availableWidth - timeout.length);
			const displayCmd = truncateToWidth(
				theme.fg("accent", baseCmd),
				Math.max(1, reserve - prefix.length),
				"…",
			);
			text.setText(
				fillToolBackground(`${prefix}${displayCmd}${timeout}`, BG_BASE, terminalWidth?.()),
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
			const structuredError = renderCtx.isError && d?._type === "bashResult";

			if (renderCtx.isError && (!structuredError || isPartial)) {
				text.setText(renderToolError(getTextContent(result) || "Error", theme));
				return text;
			}

			// Auto-collapse: show summary line after delay
			const cs = renderCtx.state as CollapseState;
			if (!isPartial && tickCollapse("bash", cs, renderCtx.invalidate, renderCtx.expanded)) {
				if (d?._type === "bashResult") {
					const normalizedText = normalizeLineEndings(d.text as string)
						.replace(/\n{3,}/g, "\n\n")
						.replace(/^\n+|\n+$/g, "");
					const lc = normalizedText ? normalizedText.split("\n").length : 0;
					const durationMs = Number(d.durationMs ?? 0);
					const exitCode = d.exitCode as number | null;
					const status = exitCode === null ? "warning" : exitCode === 0 ? "success" : "error";
					const meta = dotJoin([
						exitCode !== null && exitCode !== 0 && `exit ${exitCode}`,
						lc > 0 && `${lc} ${lc === 1 ? "line" : "lines"}`,
						durationMs > 0 && formatBashDuration(durationMs),
					]);
					text.setText(
						renderCollapsedToolRow(
							theme,
							"bash",
							summarizeBashCommand(String(d.command ?? "")),
							meta,
							status,
						),
					);
				} else {
					text.setText(fillToolBackground(`  ${theme.fg("muted", "done")}`));
				}
				return text;
			}

			if (renderCtx.isError) {
				text.setText(renderToolError(getTextContent(result) || "Error", theme));
				return text;
			}

			if (d?._type === "bashResult") {
				const normalizedText = normalizeLineEndings(d.text as string)
					.replace(/\n{3,}/g, "\n\n")
					.replace(/^\n+|\n+$/g, "");
				const { summary } = renderBashOutput(normalizedText, d.exitCode as number | null, theme);
				const lines = normalizedText ? normalizedText.split("\n") : [];
				const lineCount = lines.length;
				const header = summary;

				if (!normalizedText) {
					text.setText(fillToolBackground(header));
					return text;
				}

				const maxShow = renderCtx.expanded ? lineCount : MAX_PREVIEW_LINES;
				const show = lines.slice(0, maxShow);
				const footer =
					lineCount > maxShow ? [`${FG_DIM}  … ${lineCount - maxShow} more lines${RST}`] : [];
				// Every result (including single-line) is framed; the rules follow exit
				// status: green ok, red failure, dim unknown. The `✓ exit N` header is
				// dropped — the collapsed row already carries status.
				const exitCode = d.exitCode as number | null;
				const statusKey = exitCode === null ? "dim" : exitCode === 0 ? "success" : "error";
				const paint = (s: string) => theme.fg(statusKey, s);
				const out = ruleFrame(
					show.map((line) => `  ${line}`),
					footer,
					termW(),
					paint,
				);
				text.setText(fillToolBackground(out.join("\n")));
				return text;
			}

			const fallback = result.content?.[0];
			const fallbackText = fallback && isTextContent(fallback) ? fallback.text : "done";
			text.setText(fillToolBackground(`  ${theme.fg("dim", String(fallbackText).slice(0, 120))}`));
			return text;
		},
	});
}
