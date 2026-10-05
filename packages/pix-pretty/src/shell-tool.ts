/**
 * shell-tool — shared registrar + renderer for command-shell tools.
 *
 * pix-bash (`bash`) and pix-powershell (`powershell`) wrap Pi's built-in
 * shell tool definitions (both built on Pi's `createShellToolDefinition`) and
 * render them identically: a compact call line, a status-colored framed body,
 * a live five-line tail while streaming, and an auto-collapsed one-line row.
 * Only the tool name and the command summarizer differ per shell.
 */

import type { AgentToolUpdateCallback, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";
import { resolveBaseBackground } from "./ansi.ts";
import { collapsedCommandRow, commandPreview } from "./command-preview.ts";
import { MAX_PREVIEW_LINES } from "./config.ts";
import { icon } from "./icon-catalog.ts";
import { renderBashOutput } from "./renderers.ts";
import type { ToolContext } from "./tools/context.ts";
import type {
	BashParams,
	PiPrettyApi,
	RenderContextLike,
	ThemeLike,
	ToolFactory,
	ToolResultLike,
} from "./types.ts";
import {
	BODY_PAD,
	bodyLine,
	dotJoin,
	fillToolBackground,
	formatCollapsedToolRow,
	frameToolResult,
	getErrorMessage,
	getTextContent,
	hideCollapsedToolCall,
	isTextContent,
	moreLines,
	padIcon,
	renderToolError,
	ruleFrame,
	setResultDetails,
	termW,
	unframeToolResult,
} from "./utils.ts";
import { formatDuration } from "./widget-format.ts";

export interface ShellToolOptions {
	/** Tool name to register (and collapse-config key), e.g. `"bash"`, `"powershell"`. */
	name: string;
	/** One-line command summary used by the auto-collapsed row. */
	summarize: (command: string) => string;
	/** Output that implies failure when no explicit exit code is reported. */
	failurePattern?: RegExp;
}

const EXIT_CODE_RE = /(?:exit code|exited with(?: code)?|exit status)[:\s]*(\d+)/i;

/** Drop cursor/erase CSI + OSC sequences (keep SGR colors) so progress-bar
 *  control codes don't leak into the TUI as literal escape junk. */
function stripNonSgrCsi(text: string): string {
	return text
		.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "") // OSC …BEL/ST
		.replace(/\x1b\[[?][0-9;]*[A-Za-z]/g, "") // private-mode CSI (?25l etc.)
		.replace(/\x1b\[[0-9;]*[A-HJKSTfhl]/g, ""); // cursor move / erase CSI
}

/**
 * Progress bars rewrite one line with CR (and often ESC[K). Treat each CR as
 * "overwrite this line", not a newline — otherwise every tick dumps a new row
 * and the card scrolls with dozens of near-identical frames.
 *
 * Split on LF first: `.` does not match CR, so a single `/^.*$/gm` pass would
 * miss CR-only progress streams entirely.
 */
export function collapseProgressFrames(text: string): string {
	return text
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => {
			const cr = line.lastIndexOf("\r");
			return stripNonSgrCsi(cr >= 0 ? line.slice(cr + 1) : line);
		})
		.join("\n");
}

/** Canonical shell output normalization: collapse CR progress frames, then
 *  squeeze blank runs and trim. */
export function normalizeShellText(text: string): string {
	return collapseProgressFrames(text)
		.replace(/\n{3,}/g, "\n\n")
		.replace(/^\n+|\n+$/g, "");
}

/** Register `options.name` as a pretty-rendered wrapper around a Pi shell tool. */
export function registerShellTool(
	pi: PiPrettyApi,
	createTool: ToolFactory<BashParams>,
	ctx: ToolContext,
	options: ShellToolOptions,
): void {
	const { cwd, TextComponent } = ctx;
	const { name, failurePattern } = options;
	const origTool = createTool(cwd);

	pi.registerTool({
		...origTool,
		name,
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
				const exitMatch = text.match(EXIT_CODE_RE);
				const exitCode = exitMatch ? Number(exitMatch[1]) : failurePattern?.test(text) ? 1 : 0;
				return {
					_type: "bashResult" as const,
					text,
					exitCode,
					command: params.command ?? "",
					durationMs: Date.now() - startedAt,
				};
			};

			try {
				const result = (await origTool.execute(tid, params, sig, upd, toolCtx)) as ToolResultLike;
				setResultDetails(result, details(getTextContent(result)));
				return result;
			} catch (error) {
				const text = getErrorMessage(error);
				if (!EXIT_CODE_RE.test(text)) throw error;
				return {
					content: [{ type: "text" as const, text }],
					details: details(text),
					isError: true,
				};
			}
		},

		renderCall(args: BashParams, theme: ThemeLike, renderCtx: RenderContextLike) {
			resolveBaseBackground(theme);
			const displayCmdRaw = (args.command ?? "").trim();
			const text = renderCtx.lastComponent ?? new TextComponent("", 0, 0);
			const status =
				renderCtx.isPartial !== false ? "warning" : renderCtx.isError ? "error" : "success";
			const statusIcon =
				status === "warning" ? "status.running" : status === "error" ? "status.error" : "status.ok";
			const label = `${theme.fg(status, padIcon(icon(statusIcon)))} ${theme.fg("toolTitle", theme.bold(name))}`;
			const collapseState = renderCtx.state as CollapseState;
			if (hideCollapsedToolCall(collapseState, renderCtx.expanded, (value) => text.setText(value)))
				return text;
			const timeout = args.timeout ? ` ${theme.fg("muted", `(${args.timeout}s timeout)`)}` : "";
			return commandPreview(
				label + timeout,
				displayCmdRaw,
				name === "powershell" ? "powershell" : "bash",
				theme,
				renderCtx.state,
				renderCtx.invalidate,
				renderCtx.expanded,
				3,
			);
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
			const structuredError = renderCtx.isError && d?._type === "bashResult";

			if (renderCtx.isError && (!structuredError || isPartial)) {
				text.setText(renderToolError(getTextContent(result) || "Error", theme));
				return isPartial ? text : completed();
			}

			// Auto-collapse: show summary line after delay
			const cs = renderCtx.state as CollapseState;
			if (!isPartial && tickCollapse(name, cs, renderCtx.invalidate, renderCtx.expanded)) {
				if (d?._type === "bashResult") {
					const normalizedText = normalizeShellText(d.text as string);
					const lc = normalizedText ? normalizedText.split("\n").length : 0;
					const durationMs = Number(d.durationMs ?? 0);
					const exitCode = d.exitCode as number | null;
					const status = exitCode === null ? "warning" : exitCode === 0 ? "success" : "error";
					const meta = dotJoin([
						exitCode !== null && exitCode !== 0 && `exit ${exitCode}`,
						lc > 0 && `${lc} ${lc === 1 ? "line" : "lines"}`,
						durationMs > 0 && formatDuration(durationMs, "bash"),
					]);
					return collapsedCommandRow(
						formatCollapsedToolRow(theme, name, "", meta, status).trimEnd(),
						String(d.command ?? ""),
						theme,
					);
				} else {
					text.setText(fillToolBackground(`${BODY_PAD}${theme.fg("muted", "done")}`));
				}
				return text;
			}

			if (renderCtx.isError) {
				text.setText(renderToolError(getTextContent(result) || "Error", theme));
				return completed();
			}

			if (d?._type === "bashResult") {
				const normalizedText = normalizeShellText(d.text as string);
				const { summary } = renderBashOutput(normalizedText, d.exitCode as number | null, theme);
				const lines = normalizedText ? normalizedText.split("\n") : [];
				const lineCount = lines.length;

				if (!normalizedText) {
					text.setText(fillToolBackground(summary));
					return isPartial ? text : completed();
				}

				const maxShow = renderCtx.expanded ? lineCount : MAX_PREVIEW_LINES;
				const show = lines.slice(0, maxShow);
				const footer = lineCount > maxShow ? [moreLines(lineCount - maxShow, theme)] : [];
				// Every result (including single-line) is framed; the rules follow exit
				// status: green ok, red failure. The `✓ exit N` header is dropped — the
				// collapsed row already carries status.
				const exitCode = d.exitCode as number | null;
				const statusKey = exitCode === null || exitCode === 0 ? "success" : "error";
				const paint = (s: string) => theme.fg(statusKey, s);
				const body = show.map((line) => bodyLine(line, theme));
				const out = isPartial ? [...body, ...footer] : ruleFrame(body, footer, termW(), paint);
				text.setText(fillToolBackground(out.join("\n")));
				return text;
			}

			const fallback = result.content?.[0];
			const fallbackText = fallback && isTextContent(fallback) ? fallback.text : "done";
			if (isPartial) {
				const liveLines = normalizeShellText(String(fallbackText)).split("\n").slice(-5);
				text.setText(
					fillToolBackground(
						liveLines.map((line) => bodyLine(line, theme, (l) => theme.fg("dim", l))).join("\n"),
					),
				);
				return text;
			}
			text.setText(
				fillToolBackground(`${BODY_PAD}${theme.fg("dim", String(fallbackText).slice(0, 120))}`),
			);
			return completed();
		},
	});
}
