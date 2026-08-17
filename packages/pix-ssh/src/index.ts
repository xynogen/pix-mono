/**
 * pix-ssh — Pi extension
 *
 * Registers an `ssh_run` tool: run a shell command on a remote host over SSH,
 * optionally as root (remote sudo). One overlay handles confirm + any needed
 * password entry, mirroring pix-sudo.
 *
 * Auth:
 *   - SSH: key/agent/existing-master first (BatchMode probe). If that fails,
 *     a masked overlay collects the login password (fed to `sshpass -e` via
 *     env — never argv, never disk). Login password is cached in-memory per
 *     host for the session.
 *   - Remote sudo (`sudo: true`): a separate masked prompt collects the remote
 *     sudo password, piped to the remote `sudo -S` on stdin (inside the
 *     encrypted channel). Cached in-memory per host for the session.
 *
 * Connection reuse: OpenSSH ControlMaster multiplexing keeps one authenticated
 * connection per host alive (ControlPersist window), so repeat calls skip
 * re-auth.
 *
 * Security notes:
 *   - Passwords never leave JS memory; never written to disk; never in argv.
 *   - Every command still requires explicit per-call confirmation in the UI.
 *   - No UI (RPC / JSON mode) = blocked immediately.
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
	getTextContent,
	hideCollapsedToolCall,
	normalizeLineEndings,
	renderCollapsedToolRow,
	renderToolError,
	ruleFrame,
	termW,
} from "@xynogen/pix-pretty/utils";
import { withAgentBlock } from "@xynogen/pix-runtime";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";
import { Type } from "typebox";
import {
	APPROVAL_TTL_MS,
	commandEscalatesPrivilege,
	controlPathFor,
	detectSshFailure,
	detectSudoFailure,
	type HostSpec,
	hostApproved,
	hostTarget,
	MAX_OUTPUT_BYTES,
	MAX_OUTPUT_LINES,
	parseHost,
	probeKeyAuth,
	resolveSshHost,
	runSsh,
	truncate,
} from "./lib.ts";

const PROMPT_TIMEOUT_MS = 60_000;
const MAX_PASSWORD_ATTEMPTS = 3;

// In-memory per-host credential cache (session-scoped, never persisted).
// Key = canonical "user@host:port". Cleared on process exit.
interface HostCreds {
	loginPassword?: string;
	sudoPassword?: string;
}
const credCache = new Map<string, HostCreds>();

// Per-host allow-memory (on by default): once the user approves any command on
// a host, later calls to that host skip the confirm overlay until the approval
// expires — mirroring sudo's PAM ticket window (~15 min), not the whole session.
// Password prompts are NOT skipped — a still-missing login or sudo password
// always re-prompts. Each auto-approve emits a visible notify so the decision is
// never silent. Map value = epoch ms when the approval lapses (see APPROVAL_TTL_MS).
const approvedHosts = new Map<string, number>();

function cacheKey(spec: HostSpec): string {
	return `${spec.user ?? ""}@${spec.host}:${spec.port ?? 22}`;
}

type SshOutcome =
	| "awaiting-approval"
	| "running"
	| "success"
	| "denied"
	| "timed-out"
	| "cancelled"
	| "error";

type SshCancellationKind = "denied" | "timeout" | "missing-password" | "aborted";
type SshErrorKind = "no-ui" | "auth-ssh" | "auth-sudo" | "execution" | "no-result" | "exit-code";

export interface SshResultDetails {
	_type: "sshResult";
	command: string;
	host: string;
	sudo?: boolean;
	reason?: string;
	outcome: SshOutcome;
	exitCode?: number;
	lineCount?: number;
	truncated?: boolean;
	cancellationKind?: SshCancellationKind;
	errorKind?: SshErrorKind;
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
	host: string,
	sudo: boolean,
	reason: string | undefined,
	fields: Omit<SshResultDetails, "_type" | "command" | "host" | "sudo" | "reason">,
): SshResultDetails {
	return {
		_type: "sshResult",
		command,
		host,
		sudo,
		...(reason?.trim() ? { reason: reason.trim() } : {}),
		...fields,
	};
}

function outputLineCount(output: string): number {
	const normalized = normalizeLineEndings(output).replace(/^\n+|\n+$/g, "");
	return normalized ? normalized.split("\n").length : 0;
}

function updatePresentation(
	onUpdate: AgentToolUpdateCallback<SshResultDetails> | undefined,
	command: string,
	host: string,
	sudo: boolean,
	reason: string | undefined,
	outcome: "awaiting-approval" | "running",
): void {
	onUpdate?.({
		content: [
			{
				type: "text",
				text: outcome === "awaiting-approval" ? "Awaiting approval…" : `Running on ${host}…`,
			},
		],
		details: makeDetails(command, host, sudo, reason, { outcome }),
	});
}

function terminalMeta(details: SshResultDetails): string {
	if (details.outcome === "denied") return "denied";
	if (details.outcome === "timed-out") return "timed out";
	if (details.outcome === "cancelled") return "cancelled";
	if (details.errorKind === "no-ui") return "interactive session required";
	if (details.errorKind === "auth-ssh") return "ssh auth failed";
	if (details.errorKind === "auth-sudo") return "sudo auth failed";
	if (details.errorKind === "execution" || details.errorKind === "no-result") return "failed";

	const hasLines = typeof details.lineCount === "number" && details.lineCount > 0;
	return dotJoin([
		typeof details.exitCode === "number" && `exit ${details.exitCode}`,
		hasLines && `${details.lineCount} ${details.lineCount === 1 ? "line" : "lines"}`,
		details.truncated && "truncated",
	]);
}

function isTerminal(details: SshResultDetails): boolean {
	return details.outcome !== "awaiting-approval" && details.outcome !== "running";
}

function cancelResult(
	command: string,
	host: string,
	sudo: boolean,
	reason: string | undefined,
	action: OverlayResult["action"],
): { content: { type: "text"; text: string }[]; details: SshResultDetails } {
	const cancellationKind: SshCancellationKind =
		action === "timeout" ? "timeout" : action === "denied" ? "denied" : "missing-password";
	const outcome: SshOutcome =
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
	return {
		content: [{ type: "text", text: `Cancelled — ${msg}` }],
		details: makeDetails(command, host, sudo, reason, { outcome, cancellationKind }),
	};
}

// ── Extension entry point ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ssh_run",
		label: "Run over SSH",
		description:
			"Run a command through the remote host's configured SSH shell, optionally through POSIX sudo. " +
			"Basic cmd/PowerShell/pwsh commands may work, but Windows shells are best-effort: shell selection, " +
			"quoting, PowerShell error/stream/encoding semantics, interactive prompts, and Windows " +
			"administrator/UAC elevation are not supported. Back away and tell the user when correctness " +
			"depends on one of those limits. Handles connection and password entry through a permission dialog. " +
			"A configured approval window or YOLO mode may auto-approve non-privileged commands when no password is missing. " +
			"SSH auth tries key/agent first, then prompts for a login password if needed. " +
			"Set `sudo: true` to run the command as root on the remote machine (prompts for the " +
			"remote sudo password). Always provide a clear `reason`.",
		promptSnippet: "Run a remote SSH command (Windows shells best-effort; POSIX sudo only)",
		promptGuidelines: [
			"ssh_run sends commands to the remote host's configured SSH shell. Basic cmd, PowerShell, or " +
				"pwsh commands may work, but treat Windows shells as best-effort. Back away and tell the user " +
				"when correctness depends on explicit shell selection, complex quoting, PowerShell error/stream/encoding " +
				"semantics, interactive prompts, or Windows administrator/UAC elevation. `sudo` covers POSIX sudo " +
				"only. Provide `host` as `[user@]host[:port]` and always explain the intent in `reason`.",
		],

		renderShell: "self",

		parameters: Type.Object({
			host: Type.String({
				description: "Remote target as `[user@]host[:port]` (e.g. `deploy@10.0.0.5:2222`).",
			}),
			command: Type.String({
				description: "Command sent to the remote host's configured SSH shell.",
			}),
			sudo: Type.Optional(
				Type.Boolean({
					description: "Run the command as root on the remote host via sudo. Default false.",
				}),
			),
			reason: Type.Optional(
				Type.String({
					description: "Short plain-English explanation of intent, shown to the user.",
				}),
			),
		}),

		async execute(_toolCallId, params, sig, onUpdate, ctx) {
			const { command, reason } = params;
			const sudo = params.sudo === true;

			let spec: HostSpec;
			try {
				spec = parseHost(params.host);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `ssh_run failed: ${msg}` }],
					details: makeDetails(command, params.host, sudo, reason, {
						outcome: "error",
						errorKind: "execution",
					}),
					isError: true,
				};
			}
			// ponytail: let OpenSSH own config parsing; `ssh -G` handles aliases,
			// Include, and Match rules without duplicating its config grammar.
			const effectiveSpec = await resolveSshHost(spec, sig);
			const host = hostTarget(effectiveSpec);
			// Keep original target for execution so alias-specific IdentityFile,
			// ProxyJump, and other SSH config options still apply.
			const controlPath = controlPathFor(effectiveSpec);
			const key = cacheKey(effectiveSpec);
			const creds = credCache.get(key) ?? {};

			const g = globalThis as { __pixAfk?: boolean; __pixYolo?: boolean };
			const yolo = g.__pixYolo === true;
			if (g.__pixAfk === true && !yolo) {
				return {
					content: [{ type: "text", text: "ssh_run denied immediately — AFK mode is active." }],
					details: makeDetails(command, host, sudo, reason, {
						outcome: "denied",
						cancellationKind: "denied",
					}),
				};
			}

			if (!ctx.hasUI) {
				return {
					content: [
						{ type: "text", text: "ssh_run requires an interactive session (no UI available)." },
					],
					details: makeDetails(command, host, sudo, reason, {
						outcome: "error",
						errorKind: "no-ui",
					}),
					isError: true,
				};
			}

			updatePresentation(onUpdate, command, host, sudo, reason, "awaiting-approval");

			// Probe key/agent/existing-master auth (no password needed on success).
			// Only prompt for a login password when the host is reachable but rejects
			// key auth ("auth"). If it's unreachable (timeout/DNS/refused) a password
			// can't help — skip the prompt and let runSsh surface the real error.
			const probe = creds.loginPassword ? "ok" : await probeKeyAuth(spec, controlPath, sig);
			const keyOk = probe === "ok";
			// Which passwords must the overlay collect this call?
			const needLogin = probe === "auth" && !creds.loginPassword;
			const needSudo = sudo && !creds.sudoPassword;
			// The overlay stage pipeline: any password we still need is prompted
			// (login first, then sudo). Confirm-only when nothing is missing.
			const promptFor: ("login" | "sudo")[] = [
				...(needLogin ? (["login"] as const) : []),
				...(needSudo ? (["sudo"] as const) : []),
			];

			const body = [
				reason?.trim() ? `Intent: ${reason.trim()}` : "No reason provided by AI",
				`Host: ${host}${spec.port ? ` (port ${spec.port})` : ""}`,
				`Command: ${sudo ? "sudo " : ""}${command}`,
				...(keyOk && !creds.loginPassword ? ["(key-based auth — no login password needed)"] : []),
			];

			const collected: { login?: string; sudo?: string } = {};

			// Collect each still-missing password through the same overlay pattern
			// pix-sudo uses (masked input, N attempts). We can't validate remote
			// passwords without connecting, so validatePassword just accepts a
			// non-empty entry; a wrong password surfaces as an auth error after run.
			// Session allow-memory: host already approved + no password missing → skip
			// the confirm overlay entirely (visible notify below). Privileged commands
			// (sudo:true, or a sudo/su/doas/pkexec token in the command text) are never
			// auto-approved — they always re-confirm.
			const privileged = sudo || commandEscalatesPrivilege(command);
			const alreadyApproved =
				!privileged && hostApproved(approvedHosts, key) && promptFor.length === 0;
			if (alreadyApproved) {
				ctx.ui.notify(`🔐 ssh_run auto-approved — ${host} allowed this session`, "warning");
			}

			const runOverlay = (): Promise<OverlayResult> =>
				withAgentBlock(pi.events, "ssh_run", "SSH approval required", async () => {
					if ((yolo || alreadyApproved) && promptFor.length === 0) {
						return { action: "approved", password: "" } as OverlayResult;
					}
					// Confirm-only when no password is missing.
					if (promptFor.length === 0) {
						return showOverlay(ctx.ui, {
							mode: "confirm",
							title: "🔐 SSH COMMAND REQUEST",
							body,
							accent: sudo ? "error" : "accent",
							timeoutMs: PROMPT_TIMEOUT_MS,
							choices: [
								{ value: "yes", label: "Allow", description: "Run the command" },
								{ value: "no", label: "Deny", description: "Block the command" },
							],
						});
					}
					// One masked prompt per missing password, in order.
					let last: OverlayResult = { action: "approved", password: "" };
					for (const stage of promptFor) {
						const label = stage === "login" ? "SSH login password" : "Remote sudo password";
						last = await showOverlay(ctx.ui, {
							mode: "sudo",
							title: "🔐 SSH COMMAND REQUEST",
							body: [...body, `Enter: ${label}`],
							accent: sudo ? "error" : "accent",
							timeoutMs: PROMPT_TIMEOUT_MS,
							maxPasswordAttempts: MAX_PASSWORD_ATTEMPTS,
							passwordLabel: `${label}:`,
							validatePassword: (pw) => Promise.resolve(pw.trim().length > 0),
							choices: [
								{
									value: "yes",
									label: "Allow",
									description: `Enter ${label.toLowerCase()}`,
								},
								{ value: "no", label: "Deny", description: "Block the command" },
							],
						});
						if (last.action !== "approved" || !last.password?.trim()) return last;
						if (stage === "login") collected.login = last.password;
						else collected.sudo = last.password;
					}
					return last;
				});

			const overlayResult = await runOverlay();
			const missing =
				overlayResult.action === "approved" &&
				((needLogin && !collected.login) || (needSudo && !collected.sudo));
			if (overlayResult.action !== "approved" || missing) {
				const r = cancelResult(command, host, sudo, reason, overlayResult.action);
				ctx.ui.notify(`🔐 ${r.content[0]?.text}`, "warning");
				return r;
			}

			// Remember this host's approval until the TTL lapses (refreshed each call).
			approvedHosts.set(key, Date.now() + APPROVAL_TTL_MS);

			// Persist newly-entered passwords in the session cache.
			const loginPassword = creds.loginPassword ?? collected.login;
			const sudoPassword = creds.sudoPassword ?? collected.sudo;
			credCache.set(key, {
				...(loginPassword ? { loginPassword } : {}),
				...(sudoPassword ? { sudoPassword } : {}),
			});

			updatePresentation(onUpdate, command, host, sudo, reason, "running");

			let result: { stdout: string; stderr: string; code: number } | undefined;
			try {
				result = await runSsh(spec, command, {
					controlPath,
					...(loginPassword ? { loginPassword } : {}),
					sudo,
					...(sudo ? { sudoPassword: sudoPassword ?? "" } : {}),
					...(sig ? { signal: sig } : {}),
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `ssh_run failed: ${msg}` }],
					details: makeDetails(
						command,
						host,
						sudo,
						reason,
						sig?.aborted
							? { outcome: "cancelled", cancellationKind: "aborted" }
							: { outcome: "error", errorKind: "execution" },
					),
					isError: sig?.aborted !== true,
				};
			}

			if (!result) {
				return {
					content: [{ type: "text", text: "ssh_run failed: command produced no result" }],
					details: makeDetails(command, host, sudo, reason, {
						outcome: "error",
						errorKind: "no-result",
					}),
					isError: true,
				};
			}

			// SSH auth failure → drop the bad login password from the cache so the
			// next call re-prompts.
			if (detectSshFailure(result.code, result.stderr)) {
				credCache.delete(key);
				ctx.ui.notify("🔐 SSH authentication failed", "error");
				return {
					content: [{ type: "text", text: `SSH authentication failed:\n${result.stderr}` }],
					details: makeDetails(command, host, sudo, reason, {
						outcome: "error",
						exitCode: result.code,
						lineCount: outputLineCount(result.stderr),
						errorKind: "auth-ssh",
						_render: normalizeLineEndings(result.stderr),
					}),
					isError: true,
				};
			}

			// Remote sudo password failure → drop the bad sudo password.
			if (sudo && detectSudoFailure(result.stderr)) {
				credCache.set(key, loginPassword ? { loginPassword } : {});
				ctx.ui.notify("🔐 Remote sudo authentication failed", "error");
				return {
					content: [{ type: "text", text: `Remote sudo authentication failed:\n${result.stderr}` }],
					details: makeDetails(command, host, sudo, reason, {
						outcome: "error",
						exitCode: result.code,
						lineCount: outputLineCount(result.stderr),
						errorKind: "auth-sudo",
						_render: normalizeLineEndings(result.stderr),
					}),
					isError: true,
				};
			}

			const combined = [result.stdout, result.stderr].filter(Boolean).join("\n") || "(no output)";
			const { text: truncatedText, truncated } = truncate(combined);
			const suffix = truncated
				? `\n\n[Output truncated to ${MAX_OUTPUT_LINES} lines / ${MAX_OUTPUT_BYTES / 1024}KB]`
				: "";
			const rendered = normalizeLineEndings(combined)
				.replace(/\n{3,}/g, "\n\n")
				.replace(/^\n+|\n+$/g, "");

			return {
				content: [{ type: "text", text: `Exit code: ${result.code}\n\n${truncatedText}${suffix}` }],
				details: makeDetails(command, host, sudo, reason, {
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
			args: { command: string; host: string; sudo?: boolean; reason?: string },
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
			const host = safeOneLine(args.host);
			const prefix = args.sudo ? "sudo " : "";
			text.setText(
				fillToolBackground(
					`${theme.fg("toolTitle", theme.bold("ssh"))} ${theme.fg("dim", host)} ${theme.fg("accent", prefix + command)}`,
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
			const text = renderCtx.lastComponent ?? new Text("", 0, 0);
			const details = result.details as SshResultDetails | undefined;

			if (details?._type !== "sshResult") {
				if (renderCtx.isError) {
					text.setText(renderToolError(getTextContent(result) || "Error", theme));
				} else {
					text.setText(
						fillToolBackground(`  ${theme.fg("dim", getTextContent(result) || "done")}`),
					);
				}
				return text;
			}

			if (
				isTerminal(details) &&
				tickCollapse(
					"ssh",
					renderCtx.state as CollapseState,
					renderCtx.invalidate,
					renderCtx.expanded,
				)
			) {
				const status =
					details.outcome === "success"
						? "success"
						: details.outcome === "error"
							? "error"
							: "warning";
				text.setText(
					renderCollapsedToolRow(
						theme,
						"ssh",
						`${details.host}  ${safeOneLine(details.command)}`,
						terminalMeta(details),
						status,
					),
				);
				return text;
			}

			if (details.outcome === "awaiting-approval" || details.outcome === "running") {
				text.setText(
					fillToolBackground(`  ${theme.fg("dim", getTextContent(result) || "working")}`),
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
				return text;
			}

			const code = typeof details.exitCode === "number" ? details.exitCode : null;
			const rendered = typeof details._render === "string" ? details._render : "";
			const { summary } = renderBashOutput(rendered, code, theme);
			const lines = rendered ? rendered.split("\n") : [];
			const lineCount = lines.length;

			if (!rendered) {
				text.setText(fillToolBackground(`  ${summary}`));
				return text;
			}

			const maxShow = renderCtx.expanded ? lineCount : MAX_PREVIEW_LINES;
			const show = lines.slice(0, maxShow);
			const footer =
				lineCount > maxShow ? [`${FG_DIM}  … ${lineCount - maxShow} more lines${RST}`] : [];
			const statusKey = code === null ? "dim" : code === 0 ? "success" : "error";
			const paint = (s: string) => theme.fg(statusKey, s);
			const out = ruleFrame(
				show.map((line) => `  ${line}`),
				footer,
				termW(),
				paint,
			);
			text.setText(fillToolBackground(out.join("\n")));
			return text;
		}) as never,
	});
}
