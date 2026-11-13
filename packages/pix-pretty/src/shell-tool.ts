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
	frameToolResult,
	getErrorMessage,
	getTextContent,
	hideCollapsedToolCall,
	isTextContent,
	outputBodyRows,
	renderRow,
	renderTitle,
	renderToolError,
	reuseText,
	setResultDetails,
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
			const text = reuseText(renderCtx.lastComponent, TextComponent);
			const label = renderTitle(theme, name, renderCtx);
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
				renderCtx,
			);
		},

		renderResult(
			result: ToolResultLike,
			_opt: unknown,
			theme: ThemeLike,
			renderCtx: RenderContextLike,
		) {
			resolveBaseBackground(theme);
			const text = reuseText(renderCtx.lastComponent, TextComponent);
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
					// Host time (monotonic, persisted) wins; details keep old hosts and sessions working.
					const durationMs = Number(renderCtx.durationMs ?? d.durationMs ?? 0);
					const exitCode = d.exitCode as number | null;
					const status = exitCode === null ? "warning" : exitCode === 0 ? "success" : "error";
					const meta = dotJoin([
						exitCode !== null && exitCode !== 0 && `exit ${exitCode}`,
						lc > 0 && `${lc} ${lc === 1 ? "line" : "lines"}`,
						durationMs > 0 && formatDuration(durationMs, "bash"),
					]);
					return collapsedCommandRow(
						renderRow(theme, name, "", meta, status).trimEnd(),
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

				if (!normalizedText) {
					text.setText(fillToolBackground(summary));
					return isPartial ? text : completed();
				}

				// Every result (including single-line) is framed; the rules follow exit
				// status: green ok, red failure. The `✓ exit N` header is dropped — the
				// collapsed row already carries status.
				const exitCode = d.exitCode as number | null;
				const status = exitCode === null || exitCode === 0 ? "success" : "error";
				const out = outputBodyRows(lines, theme, renderCtx, status, isPartial);
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

// ── Approval-gated command tools (ssh_run, sudo_run) ─────────────────────────

/** Lifecycle of a command that waits for user approval, then runs once. */
export type GatedCommandOutcome =
	| "awaiting-approval"
	| "running"
	| "success"
	| "denied"
	| "timed-out"
	| "cancelled"
	| "error";

/** The result fields every gated command tool reports. */
export interface GatedCommandDetails {
	command: string;
	outcome: GatedCommandOutcome;
	exitCode?: number;
	lineCount?: number;
	truncated?: boolean;
	errorKind?: string;
	_render?: string;
}

export type GatedCancellationKind = "denied" | "timeout" | "missing-password" | "aborted";

/** A closed approval overlay (timeout, deny, or no password) as an outcome plus a message. */
export function gatedCancellation(action: string): {
	outcome: "timed-out" | "denied" | "cancelled";
	cancellationKind: GatedCancellationKind;
	text: string;
} {
	if (action === "timeout")
		return {
			outcome: "timed-out",
			cancellationKind: "timeout",
			text: "Cancelled — Timed out — auto-denied.",
		};
	if (action === "denied")
		return { outcome: "denied", cancellationKind: "denied", text: "Cancelled — Denied by user." };
	return {
		outcome: "cancelled",
		cancellationKind: "missing-password",
		text: "Cancelled — Cancelled — no password entered.",
	};
}

/** One line of untrusted text: controls and runs of whitespace fold to single spaces. */
export function safeOneLine(value: string): string {
	return value
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Collapsed-row meta: the terminal outcome, else exit code, extras, line count, truncation. */
export function gatedCommandMeta(
	details: GatedCommandDetails,
	errorLabels: Record<string, string>,
	extras: Array<string | false | undefined> = [],
): string {
	if (details.outcome === "denied") return "denied";
	if (details.outcome === "timed-out") return "timed out";
	if (details.outcome === "cancelled") return "cancelled";
	const label = details.errorKind ? errorLabels[details.errorKind] : undefined;
	if (label) return label;
	const hasLines = typeof details.lineCount === "number" && details.lineCount > 0;
	return dotJoin([
		typeof details.exitCode === "number" && `exit ${details.exitCode}`,
		...extras,
		hasLines && `${details.lineCount} ${details.lineCount === 1 ? "line" : "lines"}`,
		details.truncated && "truncated",
	]);
}

/**
 * Result card for a gated command once its details are known: collapsed row when finished,
 * a muted status line while waiting or running, the diagnostic on failure, else the output.
 */
export function renderGatedCommandResult(
	result: ToolResultLike,
	details: GatedCommandDetails,
	opts: { name: string; target: string; meta: string },
	isPartial: boolean,
	theme: ThemeLike,
	renderCtx: RenderContextLike,
) {
	const text = reuseText(renderCtx.lastComponent);
	const completed = (isError: boolean) => frameToolResult(text, theme, isError);
	const status = details.outcome === "success" ? "success" : "error";
	const running = details.outcome === "awaiting-approval" || details.outcome === "running";

	if (
		!isPartial &&
		!running &&
		tickCollapse(
			opts.name,
			renderCtx.state as CollapseState,
			renderCtx.invalidate,
			renderCtx.expanded,
		)
	) {
		return collapsedCommandRow(
			renderRow(theme, opts.name, opts.target, opts.meta, status).trimEnd(),
			safeOneLine(details.command),
			theme,
		);
	}

	if (running) {
		text.setText(
			fillToolBackground(`${BODY_PAD}${theme.fg("muted", getTextContent(result) || "working")}`),
		);
		return text;
	}

	if (details.outcome !== "success" && details.errorKind !== "exit-code") {
		const diagnostic = getTextContent(result) || "Error";
		text.setText(
			details.outcome === "error"
				? renderToolError(diagnostic, theme)
				: fillToolBackground(`${BODY_PAD}${theme.fg("warning", diagnostic)}`),
		);
		return isPartial ? text : completed(true);
	}

	const code = typeof details.exitCode === "number" ? details.exitCode : null;
	const rendered = typeof details._render === "string" ? details._render : "";
	if (!rendered) {
		const { summary } = renderBashOutput(rendered, code, theme);
		text.setText(fillToolBackground(`${BODY_PAD}${summary}`));
		return isPartial ? text : completed(details.outcome !== "success");
	}

	// Every result (including single-line) is framed; the rules follow exit status: green ok,
	// red failure. The `✓ exit N` header is dropped — the collapsed row already carries status.
	const rows = outputBodyRows(rendered.split("\n"), theme, renderCtx, status, isPartial);
	text.setText(fillToolBackground(rows.join("\n")));
	return text;
}
