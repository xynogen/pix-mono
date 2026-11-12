/**
 * pix-sudo — Pi extension
 *
 * Registers a `sudo_run` tool. Before execution the user sees ONE coloured
 * overlay with two stages:
 *
 *   Stage 1 — confirm
 *     Shows AI intent; the command stays in its transcript tool card. Allow/Deny.
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

import { type OverlayResult, type OverlayUI, showOverlay } from "@xynogen/pix-pretty/gate-overlay";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { getErrorMessage, normalizeLineEndings } from "@xynogen/pix-pretty/utils";
import { getUnattendedMode } from "@xynogen/pix-runtime";
import type { AgentToolUpdateCallback, EventBus, ExtensionAPI } from "@xynogen/pix-runtime/host";
import { once } from "@xynogen/pix-runtime/once";
import { truncateOutput } from "@xynogen/pix-runtime/output";
import { currentPlatform } from "@xynogen/pix-runtime/platform";
import { runToolExecution } from "@xynogen/pix-runtime/tool-execution";
import { Type } from "typebox";
import {
	detectAuthFailure,
	hasValidTicket,
	MAX_OUTPUT_BYTES,
	MAX_OUTPUT_LINES,
	runWithSudo,
	type SudoResult,
	validateSudoPassword,
} from "./lib.ts";
import { renderSudoCall, renderSudoResult } from "./render.ts";
import {
	cancelResult,
	makeDetails,
	outputLineCount,
	type SudoDetailFields,
	type SudoResultDetails,
	updatePresentation,
} from "./result.ts";

export type { SudoResultDetails } from "./result.ts";

// Auto-deny the root prompt after this idle window (dead-man's switch). The
// first keypress cancels it, so it only fires when the user is truly away.
const ROOT_PROMPT_TIMEOUT_MS = 60_000;
const MAX_PASSWORD_ATTEMPTS = 3;

type SudoParams = { command: string; reason?: string };
type SudoUI = OverlayUI & { notify(message: string, type?: "info" | "warning" | "error"): void };
type SudoToolResult = {
	content: { type: "text"; text: string }[];
	details: SudoResultDetails;
	isError?: boolean;
};

function fail(
	{ command, reason }: SudoParams,
	text: string,
	fields: SudoDetailFields,
): SudoToolResult {
	return {
		content: [{ type: "text", text }],
		details: makeDetails(command, reason, fields),
		...(fields.outcome === "error" ? { isError: true } : {}),
	};
}

/**
 * Confirm the command, and collect + validate the password inside the same open
 * overlay. A validation that fails for a reason other than a wrong password is
 * stored in `validation.error` and reported after the overlay closes.
 */
function askApproval(
	ui: SudoUI,
	events: EventBus,
	{ reason }: SudoParams,
	cached: boolean,
	signal: AbortSignal | undefined,
	validation: { error?: unknown },
): Promise<OverlayResult> {
	const intent = reason?.trim();
	const common = {
		state: { events, source: "sudo_run" },
		signal,
		icon: icon("lock"),
		title: intent || "Root Command Request",
		accent: "error",
		timeoutMs: ROOT_PROMPT_TIMEOUT_MS,
	} as const;
	const body = [
		"Review the command in the tool card below.",
		...(intent ? [] : ["No reason provided by AI"]),
	];
	if (cached) {
		return showOverlay(ui, {
			...common,
			mode: "confirm",
			body: [...body, "(sudo session active — no password needed)"],
			choices: [
				{ value: "yes", label: "Allow", description: "Run the command" },
				{ value: "no", label: "Deny", description: "Block the command" },
			],
		});
	}
	return showOverlay(ui, {
		...common,
		mode: "sudo",
		body,
		maxPasswordAttempts: MAX_PASSWORD_ATTEMPTS,
		validatePassword: async (password, validationSignal) => {
			try {
				const result = await validateSudoPassword(password, validationSignal);
				if (detectAuthFailure(result.code, result.stderr)) return false;
				if (result.code !== 0)
					validation.error = new Error(result.stderr || "sudo password validation failed");
				return true;
			} catch (err) {
				validation.error = err;
				return true;
			}
		},
		choices: [
			{ value: "yes", label: "Allow — enter password", description: "Proceed to password prompt" },
			{
				value: "no",
				label: "Deny — block command",
				description: "Prevent this command from running",
			},
		],
	});
}

/** Map the finished root command to its tool result. */
function commandResult(params: SudoParams, result: SudoResult): SudoToolResult {
	if (detectAuthFailure(result.code, result.stderr)) {
		return fail(
			params,
			"sudo authentication failed — sudo rejected the credentials when running the command.",
			{
				outcome: "error",
				exitCode: result.code,
				lineCount: outputLineCount(result.stderr),
				truncated: false,
				errorKind: "authentication",
				_render: normalizeLineEndings(result.stderr),
			},
		);
	}
	const combined = [
		result.stdout && `[stdout]\n${result.stdout}`,
		result.stderr && `[stderr]\n${result.stderr}`,
	]
		.filter(Boolean)
		.join("\n");
	const { text: truncatedText, truncated } = truncateOutput(combined || "(no output)");
	const suffix = truncated
		? `\n\n[Output truncated to ${MAX_OUTPUT_LINES} lines / ${MAX_OUTPUT_BYTES / 1024}KB]`
		: "";
	const rendered = normalizeLineEndings(
		[result.stdout, result.stderr].filter(Boolean).join("\n") || "(no output)",
	)
		.replace(/\n{3,}/g, "\n\n")
		.replace(/^\n+|\n+$/g, "");
	return {
		content: [{ type: "text", text: `Exit code: ${result.code}\n\n${truncatedText}${suffix}` }],
		details: makeDetails(params.command, params.reason, {
			outcome: result.code === 0 ? "success" : "error",
			exitCode: result.code,
			lineCount: outputLineCount(rendered),
			truncated,
			...(result.code === 0 ? {} : { errorKind: "exit-code" as const }),
			_render: rendered,
		}),
		isError: result.code !== 0,
	};
}

async function runSudo(
	params: SudoParams,
	signal: AbortSignal | undefined,
	update: AgentToolUpdateCallback<SudoResultDetails> | undefined,
	ctx: { hasUI: boolean; ui: SudoUI },
	events: EventBus,
): Promise<SudoToolResult> {
	const { command, reason } = params;
	const mode = getUnattendedMode(events);
	const yolo = mode === "yolo" || mode === "nuclear";
	if (mode === "afk")
		return fail(params, "sudo_run denied immediately — AFK mode is active.", {
			outcome: "denied",
			cancellationKind: "denied",
		});
	if (!ctx.hasUI)
		return fail(params, "sudo_run requires an interactive session (no UI available).", {
			outcome: "error",
			errorKind: "no-ui",
		});

	updatePresentation(update, command, reason, "awaiting-approval");

	// A valid PAM ticket lets us skip the password stage (confirm only).
	signal?.throwIfAborted();
	const cached = await hasValidTicket(signal);

	// YOLO auto-approves root, but only when a PAM ticket is already cached:
	// the password cannot be auto-typed, so a no-ticket run still prompts.
	const validation: { error?: unknown } = {};
	let overlayResult: OverlayResult;
	if (yolo && cached) {
		ctx.ui.notify(`${mode.toUpperCase()} — root command auto-approved (cached ticket).`, "warning");
		overlayResult = { action: "approved", password: "" };
	} else {
		overlayResult = await askApproval(ctx.ui, events, params, cached, signal, validation);
	}

	signal?.throwIfAborted();
	// Checked before anything runs: a wrong password must never reach sudo.
	if (overlayResult.passwordAttemptsExhausted)
		return fail(
			params,
			`sudo authentication failed after ${MAX_PASSWORD_ATTEMPTS} attempts — wrong password.`,
			{ outcome: "error", errorKind: "authentication" },
		);

	// Cached ticket needs no password; otherwise a blank password is a cancel.
	const missingPassword = !cached && !overlayResult.password?.trim();
	if (overlayResult.action !== "approved" || missingPassword)
		return cancelResult(command, reason, overlayResult.action);

	if (validation.error)
		return fail(params, `sudo_run failed: ${getErrorMessage(validation.error)}`, {
			outcome: "error",
			errorKind: "authentication",
		});

	updatePresentation(update, command, reason, "running");
	// Password validation (`sudo -v`) only gates the overlay; its ticket may not
	// carry over to a new process, so the command gets the password again.
	return commandResult(params, await runWithSudo(command, overlayResult.password ?? "", signal));
}

export default function pixSudo(pi: ExtensionAPI): void {
	once(pi, "pix-sudo", () => register(pi));
}

function register(pi: ExtensionAPI): void {
	// sudo does not exist on Windows (catalog: UNIX only). Registering the tool
	// there only offers the model a command that can never run.
	if (currentPlatform().os === "win32") return;
	pi.registerTool({
		name: "sudo_run",
		...({ exposure: "deferred" } as const),
		label: "Run as root",
		description:
			"Execute a shell command as root on the LOCAL machine (sudo). " +
			"For a non-root local command use `bash`; for anything on a REMOTE host use `ssh_run` " +
			"(with `sudo: true` for remote root) — do not use sudo_run for remote work. " +
			"Never runs without the user's explicit approval and password. " +
			"Use only when the task genuinely requires elevated permissions " +
			"(e.g. writing to /etc, managing system services, installing packages system-wide). " +
			"You MUST provide a clear `reason` explaining why root is needed.",
		promptSnippet: "Execute a shell command as root on the local machine",
		promptGuidelines: [
			"sudo_run: LOCAL root only — never raw `sudo` in bash. Use `bash` for non-root local, `ssh_run` (`sudo: true`) for remote. Prefer plain bash; use only when root is strictly required. Set `reason` to a short why-root sentence.",
		],

		// Full-width framing (rules + bg fill) baked at termW(), like pix-bash.
		renderShell: "self",

		parameters: Type.Object({
			command: Type.String({
				description: "Shell command to run as root (passed to `sh -c`).",
			}),
			reason: Type.String({
				description:
					"Short plain-English explanation of why root is needed. " +
					"Shown to the user as the approval title.",
			}),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return runToolExecution({
				signal,
				onUpdate,
				onError: (error, cancelled) => ({
					content: [
						{
							type: "text" as const,
							text: cancelled
								? "sudo_run cancelled."
								: `sudo_run failed: ${getErrorMessage(error)}`,
						},
					],
					details: makeDetails(
						params.command,
						params.reason,
						cancelled
							? { outcome: "cancelled", cancellationKind: "aborted" }
							: { outcome: "error", errorKind: "execution" },
					),
					isError: !cancelled,
				}),
				execute: ({ update }) => runSudo(params, signal, update, ctx, pi.events),
			});
		},

		renderCall: renderSudoCall,
		renderResult: renderSudoResult,
	});
}
