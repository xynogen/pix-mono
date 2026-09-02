/**
 * pix-sudo — Pi extension
 *
 * Registers a `sudo_run` tool. Before execution the user sees ONE coloured
 * overlay with two stages:
 *
 *   Stage 1 — confirm
 *     Shows command + AI intent.  User picks Allow or Deny via SelectList.
 *     Auto-denies after 60 s.
 *
 *   Stage 2 — password (skipped when a valid PAM ticket already exists)
 *     Inline masked input (● per char) inside the same overlay.
 *     Enter submits, Esc cancels, 60 s inactivity auto-cancels.
 *
 * Security notes:
 *   - Password never leaves JS memory; never written to disk.
 *   - Every command still requires explicit per-call confirmation in the UI.
 *   - PAM timestamp cache is honoured (no `-k`): within the system sudoers
 *     timeout a repeat call skips the password prompt but NOT the confirm.
 *   - No UI (RPC / JSON mode) = blocked with isError immediately.
 *   - Output truncated to 50 KB / 2000 lines.
 */

import type { AgentToolUpdateCallback, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { FG_DIM, RST, resolveBaseBackground } from "@xynogen/pix-pretty/ansi";
import { MAX_PREVIEW_LINES } from "@xynogen/pix-pretty/config";
import { type OverlayResult, showOverlay } from "@xynogen/pix-pretty/gate-overlay";
import { renderBashOutput } from "@xynogen/pix-pretty/renderers";
import type { RenderContextLike, ThemeLike, ToolResultLike } from "@xynogen/pix-pretty/types";
import {
	dotJoin,
	fillToolBackground,
	frameToolResult,
	getTextContent,
	hideCollapsedToolCall,
	normalizeLineEndings,
	renderCollapsedToolRow,
	renderToolError,
	ruleFrame,
	sectionRule,
	termW,
	unframeToolResult,
} from "@xynogen/pix-pretty/utils";
import { getUnattendedMode, withAgentBlock } from "@xynogen/pix-runtime";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";
import { Type } from "typebox";
import {
	detectAuthFailure,
	hasValidTicket,
	MAX_OUTPUT_BYTES,
	MAX_OUTPUT_LINES,
	runWithSudo,
	truncate,
	validateSudoPassword,
} from "./lib.ts";

// Auto-deny the root prompt after this idle window (dead-man's switch). The
// first keypress cancels it, so it only fires when the user is truly away.
const ROOT_PROMPT_TIMEOUT_MS = 60_000;
const MAX_PASSWORD_ATTEMPTS = 3;

type SudoOutcome =
	| "awaiting-approval"
	| "running"
	| "success"
	| "denied"
	| "timed-out"
	| "cancelled"
	| "error";

type SudoCancellationKind = "denied" | "timeout" | "missing-password" | "aborted";
type SudoErrorKind = "no-ui" | "authentication" | "execution" | "no-result" | "exit-code";

export interface SudoResultDetails {
	_type: "sudoResult";
	command: string;
	reason?: string;
	outcome: SudoOutcome;
	exitCode?: number;
	lineCount?: number;
	truncated?: boolean;
	cancellationKind?: SudoCancellationKind;
	errorKind?: SudoErrorKind;
	_render?: string;
}

function safeOneLine(value: string): string {
	return value
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function makeDetails(
	command: string,
	reason: string | undefined,
	fields: Omit<SudoResultDetails, "_type" | "command" | "reason">,
): SudoResultDetails {
	return {
		_type: "sudoResult",
		command,
		...(reason?.trim() ? { reason: reason.trim() } : {}),
		...fields,
	};
}

function outputLineCount(output: string): number {
	const normalized = normalizeLineEndings(output).replace(/^\n+|\n+$/g, "");
	return normalized ? normalized.split("\n").length : 0;
}

function updatePresentation(
	onUpdate: AgentToolUpdateCallback<SudoResultDetails> | undefined,
	command: string,
	reason: string | undefined,
	outcome: "awaiting-approval" | "running",
): void {
	onUpdate?.({
		content: [
			{
				type: "text",
				text: outcome === "awaiting-approval" ? "Awaiting root approval…" : "Running as root…",
			},
		],
		details: makeDetails(command, reason, { outcome }),
	});
}

function terminalMeta(details: SudoResultDetails): string {
	if (details.outcome === "denied") return "denied";
	if (details.outcome === "timed-out") return "timed out";
	if (details.outcome === "cancelled") return "cancelled";
	if (details.errorKind === "no-ui") return "interactive session required";
	if (details.errorKind === "authentication") return "authentication failed";
	if (details.errorKind === "execution" || details.errorKind === "no-result") return "failed";

	const hasLines = typeof details.lineCount === "number" && details.lineCount > 0;
	return dotJoin([
		typeof details.exitCode === "number" && `exit ${details.exitCode}`,
		hasLines && `${details.lineCount} ${details.lineCount === 1 ? "line" : "lines"}`,
		details.truncated && "truncated",
	]);
}

function isTerminal(details: SudoResultDetails): boolean {
	return details.outcome !== "awaiting-approval" && details.outcome !== "running";
}

// ── Extension entry point ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "sudo_run",
		label: "Run as root",
		description:
			"Execute a shell command with root (sudo) privileges. " +
			"Always shows the user a confirmation dialog before running — " +
			"the command is NEVER executed without explicit approval and password. " +
			"Use only when the task genuinely requires elevated permissions " +
			"(e.g. writing to /etc, managing system services, installing packages system-wide). " +
			"You MUST provide a clear `reason` explaining why root is needed.",
		promptSnippet: "Execute a shell command as root after user sees intent + password prompt",
		promptGuidelines: [
			"sudo_run: prefer plain bash; use only when root is strictly required. Set `reason` to a short why-root sentence.",
		],

		// Full-width framing (rules + bg fill) baked at termW(), like pix-bash.
		renderShell: "self",

		parameters: Type.Object({
			command: Type.String({
				description: "Shell command to run as root (passed to `sh -c`).",
			}),
			reason: Type.Optional(
				Type.String({
					description:
						"Short plain-English explanation of why root is needed. " +
						"Shown to the user so they can make an informed decision.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { command, reason } = params;

			const mode = getUnattendedMode(pi.events);
			const yolo = mode === "yolo";
			if (mode === "afk") {
				return {
					content: [{ type: "text", text: "sudo_run denied immediately — AFK mode is active." }],
					details: makeDetails(command, reason, {
						outcome: "denied",
						cancellationKind: "denied",
					}),
				};
			}

			// ── No UI: block immediately ───────────────────────────────────────
			if (!ctx.hasUI) {
				return {
					content: [
						{
							type: "text",
							text: "sudo_run requires an interactive session (no UI available).",
						},
					],
					details: makeDetails(command, reason, {
						outcome: "error",
						errorKind: "no-ui",
					}),
					isError: true,
				};
			}

			updatePresentation(onUpdate, command, reason, "awaiting-approval");

			// A valid PAM ticket lets us skip the password stage (confirm only).
			const cached = await hasValidTicket();

			const body = [
				reason?.trim() ? `Intent: ${reason.trim()}` : "No reason provided by AI",
				`Command: ${command}`,
			];

			let result: { stdout: string; stderr: string; code: number } | undefined;
			let executionError: unknown;

			// ── Confirm (+ validate password inside the same open overlay) ───────
			// YOLO auto-approves root, but only when a PAM ticket is already cached:
			// the password cannot be auto-typed, so a no-ticket run still prompts.
			if (yolo && cached) {
				ctx.ui.notify("🔐 YOLO — root command auto-approved (cached ticket).", "warning");
			}
			const overlayResult = await withAgentBlock(
				pi.events,
				"sudo_run",
				"Root approval required",
				() => {
					if (yolo && cached) {
						return Promise.resolve<OverlayResult>({ action: "approved", password: "" });
					}
					if (cached) {
						return showOverlay(ctx.ui, {
							mode: "confirm",
							title: "🔐 ROOT COMMAND REQUEST",
							body: [...body, "(sudo session active — no password needed)"],
							accent: "error",
							timeoutMs: ROOT_PROMPT_TIMEOUT_MS,
							choices: [
								{ value: "yes", label: "Allow", description: "Run the command" },
								{ value: "no", label: "Deny", description: "Block the command" },
							],
						});
					}
					return showOverlay(ctx.ui, {
						mode: "sudo",
						title: "🔐 ROOT COMMAND REQUEST",
						body,
						accent: "error",
						timeoutMs: ROOT_PROMPT_TIMEOUT_MS,
						maxPasswordAttempts: MAX_PASSWORD_ATTEMPTS,
						validatePassword: async (password) => {
							try {
								const validation = await validateSudoPassword(password, signal);
								if (detectAuthFailure(validation.code, validation.stderr)) return false;
								if (validation.code !== 0) {
									executionError = new Error(
										validation.stderr || "sudo password validation failed",
									);
								}
								return true;
							} catch (err) {
								executionError = err;
								return true;
							}
						},
						choices: [
							{
								value: "yes",
								label: "Allow — enter password",
								description: "Proceed to password prompt",
							},
							{
								value: "no",
								label: "Deny — block command",
								description: "Prevent this command from running",
							},
						],
					});
				},
			);

			// Cached ticket needs no password; otherwise a blank password is a cancel.
			const missingPassword = !cached && !overlayResult.password?.trim();
			if (overlayResult.action !== "approved" || missingPassword) {
				const cancellationKind: SudoCancellationKind =
					overlayResult.action === "timeout"
						? "timeout"
						: overlayResult.action === "denied"
							? "denied"
							: "missing-password";
				const outcome: SudoOutcome =
					cancellationKind === "timeout"
						? "timed-out"
						: cancellationKind === "denied"
							? "denied"
							: "cancelled";
				const msg =
					outcome === "timed-out"
						? "Timed out — auto-denied."
						: outcome === "denied"
							? "Denied by user."
							: "Cancelled — no password entered.";
				ctx.ui.notify(`🔐 ${msg}`, "warning");
				return {
					content: [{ type: "text", text: `Cancelled — ${msg}` }],
					details: makeDetails(command, reason, { outcome, cancellationKind }),
				};
			}

			if (executionError) {
				const msg =
					executionError instanceof Error ? executionError.message : String(executionError);
				return {
					content: [{ type: "text", text: `sudo_run failed: ${msg}` }],
					details: makeDetails(command, reason, {
						outcome: "error",
						errorKind: "authentication",
					}),
					isError: true,
				};
			}

			updatePresentation(onUpdate, command, reason, "running");

			// Password validation refreshes sudo's PAM ticket with `sudo -v`; the
			// requested command always runs afterward, outside the checking overlay.
			try {
				result = await runWithSudo(command, "", signal);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `sudo_run failed: ${msg}` }],
					details: makeDetails(
						command,
						reason,
						signal?.aborted
							? { outcome: "cancelled", cancellationKind: "aborted" }
							: { outcome: "error", errorKind: "execution" },
					),
					isError: signal?.aborted !== true,
				};
			}

			if (!result) {
				return {
					content: [{ type: "text", text: "sudo_run failed: command produced no result" }],
					details: makeDetails(command, reason, {
						outcome: "error",
						errorKind: "no-result",
					}),
					isError: true,
				};
			}

			if (
				overlayResult.passwordAttemptsExhausted ||
				detectAuthFailure(result.code, result.stderr)
			) {
				ctx.ui.notify(
					`🔐 sudo authentication failed after ${MAX_PASSWORD_ATTEMPTS} attempts`,
					"error",
				);
				return {
					content: [
						{
							type: "text",
							text: `sudo authentication failed after ${MAX_PASSWORD_ATTEMPTS} attempts — wrong password.`,
						},
					],
					details: makeDetails(command, reason, {
						outcome: "error",
						exitCode: result.code,
						lineCount: outputLineCount(result.stderr),
						truncated: false,
						errorKind: "authentication",
						_render: normalizeLineEndings(result.stderr),
					}),
					isError: true,
				};
			}

			// ── Step 5: Truncate + return ──────────────────────────────────────
			const combined = [
				result.stdout && `[stdout]\n${result.stdout}`,
				result.stderr && `[stderr]\n${result.stderr}`,
			]
				.filter(Boolean)
				.join("\n");

			const { text: truncatedText, truncated } = truncate(combined || "(no output)");

			const suffix = truncated
				? `\n\n[Output truncated to ${MAX_OUTPUT_LINES} lines / ${MAX_OUTPUT_BYTES / 1024}KB]`
				: "";

			const combinedOut =
				[result.stdout, result.stderr].filter(Boolean).join("\n") || "(no output)";

			const rendered = normalizeLineEndings(combinedOut)
				.replace(/\n{3,}/g, "\n\n")
				.replace(/^\n+|\n+$/g, "");

			return {
				content: [
					{
						type: "text",
						text: `Exit code: ${result.code}\n\n${truncatedText}${suffix}`,
					},
				],
				details: makeDetails(command, reason, {
					outcome: result.code === 0 ? "success" : "error",
					exitCode: result.code,
					lineCount: outputLineCount(rendered),
					truncated,
					...(result.code === 0 ? {} : { errorKind: "exit-code" as const }),
					_render: rendered,
				}),
				isError: result.code !== 0,
			};
		},

		renderCall: ((
			args: { command: string; reason?: string },
			theme: ThemeLike,
			renderCtx: RenderContextLike,
		) => {
			resolveBaseBackground(theme);
			const text = renderCtx.lastComponent ?? new Text("", 0, 0);
			if (
				hideCollapsedToolCall(renderCtx.state as CollapseState, renderCtx.expanded, (value) =>
					text.setText(value),
				)
			)
				return text;

			const command = safeOneLine(args.command) || "(empty command)";
			text.setText(
				fillToolBackground(
					`${theme.fg("toolTitle", theme.bold("sudo"))} ${theme.fg("dim", command)}`,
				),
			);
			return text;
		}) as never,

		renderResult: ((
			result: ToolResultLike,
			_opt: unknown,
			theme: ThemeLike,
			renderCtx: RenderContextLike,
		) => {
			resolveBaseBackground(theme);
			const text = unframeToolResult(renderCtx.lastComponent ?? new Text("", 0, 0));
			const details = result.details as SudoResultDetails | undefined;
			const isPartial = (_opt as { isPartial?: boolean } | undefined)?.isPartial === true;
			const completed = (isError: boolean) => frameToolResult(text, theme, isError);

			if (details?._type !== "sudoResult") {
				if (renderCtx.isError) {
					text.setText(renderToolError(getTextContent(result) || "Error", theme));
				} else {
					text.setText(
						fillToolBackground(`  ${theme.fg("muted", getTextContent(result) || "done")}`),
					);
				}
				return isPartial ? text : completed(renderCtx.isError);
			}

			if (
				!isPartial &&
				isTerminal(details) &&
				tickCollapse(
					"sudo",
					renderCtx.state as CollapseState,
					renderCtx.invalidate,
					renderCtx.expanded,
				)
			) {
				const status = details.outcome === "success" ? "success" : "error";
				text.setText(
					renderCollapsedToolRow(
						theme,
						"sudo",
						safeOneLine(details.command),
						terminalMeta(details),
						status,
					),
				);
				return text;
			}

			if (details.outcome === "awaiting-approval" || details.outcome === "running") {
				text.setText(
					fillToolBackground(`  ${theme.fg("muted", getTextContent(result) || "working")}`),
				);
				return text;
			}

			if (details.outcome !== "success" && details.errorKind !== "exit-code") {
				const diagnostic = getTextContent(result) || "Error";
				text.setText(
					details.outcome === "error"
						? renderToolError(diagnostic, theme)
						: fillToolBackground(`  ${theme.fg("warning", diagnostic)}`),
				);
				return isPartial ? text : completed(true);
			}

			const code = typeof details.exitCode === "number" ? details.exitCode : null;
			const rendered = typeof details._render === "string" ? details._render : "";
			const { summary } = renderBashOutput(rendered, code, theme);
			const lines = rendered ? rendered.split("\n") : [];
			const lineCount = lines.length;

			if (!rendered) {
				text.setText(fillToolBackground(`  ${summary}`));
				return isPartial ? text : completed(details.outcome !== "success");
			}

			const maxShow = renderCtx.expanded ? lineCount : MAX_PREVIEW_LINES;
			const show = lines.slice(0, maxShow);
			const footer =
				lineCount > maxShow ? [`${FG_DIM}  … ${lineCount - maxShow} more lines${RST}`] : [];
			// Every result (including single-line) is framed; the rules follow exit
			// status: green ok, red failure, dim unknown. The `✓ exit N` header is
			// dropped — the collapsed row already carries status.
			const statusKey = details.outcome === "success" ? "success" : "error";
			const paint = (s: string) => theme.fg(statusKey, s);
			const sw = Math.max(8, termW() - 4); // section-rule width inside the 2-space indent
			const body = show.map((line) => `  ${sectionRule(line, theme, sw) ?? line}`);
			const out = isPartial ? [...body, ...footer] : ruleFrame(body, footer, termW(), paint);
			text.setText(fillToolBackground(out.join("\n")));
			return text;
		}) as never,
	});
}
