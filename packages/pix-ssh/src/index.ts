/**
 * pix-ssh — Pi extension
 *
 * Registers an `ssh_run` tool: run a command or transfer files/directories over
 * SSH. Commands may optionally run as root through remote sudo. One overlay
 * handles confirmation and any needed password entry, mirroring pix-sudo.
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
 *   - File transfers are warning-level and show their overwrite risk in the UI.
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
import { SPINNER } from "@xynogen/pix-pretty/widget-format";
import { getUnattendedMode, withAgentBlock } from "@xynogen/pix-runtime";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";
import { Type } from "typebox";
import {
	APPROVAL_TTL_MS,
	commandEscalatesPrivilege,
	controlPathFor,
	detectSshFailure,
	detectSudoFailure,
	type HostAlias,
	type HostInfo,
	type HostSpec,
	hostApproved,
	hostTarget,
	MAX_OUTPUT_BYTES,
	MAX_OUTPUT_LINES,
	parseHost,
	probeKeyAuth,
	readSshConfigAliases,
	resolveHostInfo,
	resolveSshHost,
	runSsh,
	runTransfer,
	type TransferDirection,
	transferApprovalDecision,
	truncate,
} from "./lib.ts";

const PROMPT_TIMEOUT_MS = 60_000;
const MAX_PASSWORD_ATTEMPTS = 3;
const SPINNER_INTERVAL_MS = 120;

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

// Flat shape mirroring the single Type.Object schema. Conditional fields are
// optional here and validated at runtime by normalizeOperation.
type SshParams = {
	action?: "command" | "file" | "info";
	host?: string;
	command?: string;
	sudo?: boolean;
	direction?: TransferDirection;
	source?: string;
	destination?: string;
	recursive?: boolean;
	reason?: string;
};

interface SshOperation {
	action: "command" | "file";
	command: string;
	sudo: boolean;
	reason?: string;
	direction?: TransferDirection;
	source: string;
	destination: string;
	recursive: boolean;
}

function normalizeOperation(params: SshParams): SshOperation {
	if (params.action === "file") {
		const source = (params.source ?? "").trim();
		const destination = (params.destination ?? "").trim();
		return {
			action: "file",
			command: `${params.direction ?? ""} ${source || "(empty source)"} → ${destination || "(empty destination)"}`,
			sudo: false,
			reason: params.reason,
			direction: params.direction,
			source,
			destination,
			recursive: params.recursive === true,
		};
	}
	return {
		action: "command",
		command: params.command ?? "",
		sudo: params.sudo === true,
		reason: params.reason,
		source: "",
		destination: "",
		recursive: false,
	};
}

function approvalBody(operation: SshOperation, host: string, port?: number): string[] {
	const { action, command, destination, direction, reason, recursive, source, sudo } = operation;
	return [
		reason?.trim() ? `Intent: ${reason.trim()}` : "No reason provided by AI",
		`Host: ${host}${port ? ` (port ${port})` : ""}`,
		...(action === "command"
			? [`Command: ${sudo ? "sudo " : ""}${command}`]
			: [
					`Direction: ${direction === "download" ? "Download" : "Upload"}`,
					`From: ${source}`,
					`To: ${destination}`,
					`Mode: ${recursive ? "Recursive copy" : "Single item"}`,
					"Warning: existing destination may be overwritten",
				]),
	];
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
	message?: string,
): void {
	onUpdate?.({
		content: [
			{
				type: "text",
				text:
					message ??
					(outcome === "awaiting-approval" ? "Awaiting approval…" : `Running on ${host}…`),
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

function formatHostInfo(host: string, info: HostInfo): string {
	const rows = [
		["HostName", info.hostname],
		["User", info.user],
		["Port", info.port],
		["ProxyJump", info.proxyJump && info.proxyJump !== "none" ? info.proxyJump : undefined],
		["IdentityFile", info.identityFile],
	].filter((r): r is [string, string] => Boolean(r[1]));
	if (rows.length === 0) return `No SSH config found for ${host}.`;
	return [`Effective SSH config for ${host}:`, ...rows.map(([k, v]) => `  ${k} ${v}`)].join("\n");
}

function formatAliasList(aliases: HostAlias[]): string {
	if (aliases.length === 0) {
		return "No SSH host aliases found in ~/.ssh/config.";
	}
	// De-dupe by alias, first block wins (OpenSSH semantics).
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const a of aliases) {
		if (seen.has(a.alias)) continue;
		seen.add(a.alias);
		let target = "";
		if (a.hostname) {
			const userPart = a.user ? `${a.user}@` : "";
			const portPart = a.port ? `:${a.port}` : "";
			target = `${userPart}${a.hostname}${portPart}`;
		}
		const via = a.proxyJump && a.proxyJump !== "none" ? ` via ${a.proxyJump}` : "";
		lines.push(`  ${a.alias}${target ? ` → ${target}` : ""}${via}`);
	}
	return [`SSH host aliases (${lines.length}):`, ...lines].join("\n");
}

/** Build the info-action result: per-host effective config when `host` is
 * given, otherwise the alias inventory from ~/.ssh/config. Read-only.
 * Details carry `_type: "sshInfo"` so renderResult falls to its generic
 * plain-text branch (no collapse, no exit-code framing). */
async function infoResult(host: string | undefined, sig?: AbortSignal) {
	const details = { _type: "sshInfo" as const };
	if (host?.trim()) {
		let spec: HostSpec;
		try {
			spec = parseHost(host);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				content: [{ type: "text" as const, text: `ssh_run failed: ${msg}` }],
				details,
				isError: true,
			};
		}
		const text = formatHostInfo(hostTarget(spec), await resolveHostInfo(spec, sig));
		return { content: [{ type: "text" as const, text }], details };
	}
	return {
		content: [{ type: "text" as const, text: formatAliasList(readSshConfigAliases()) }],
		details,
	};
}

// ── Extension entry point ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ssh_run",
		label: "Run over SSH",
		description:
			"Run a command or transfer files/directories on a REMOTE host over SSH. " +
			"For the LOCAL machine use `bash` (or `sudo_run` for local root) instead — do not use ssh_run for local work. " +
			"Requires a `host`. Windows/PowerShell shells are best-effort (elevation and PowerShell stream/encoding semantics unsupported). " +
			"Set `sudo: true` to run the command as root on the remote machine. " +
			'For transfer, set `action: "file"`, `direction`, `source`, `destination`, and optional `recursive` — ' +
			"transfers may overwrite the destination. " +
			'To discover hosts without reading `~/.ssh/config`, use `action: "info"` — omit `host` to list configured aliases, or pass a `host` to get its effective config (no connection). ' +
			"Always provide a clear `reason`.",
		promptSnippet: "Run a remote command, transfer files, or read SSH config over SSH",
		promptGuidelines: [
			'ssh_run: REMOTE host only — use `bash`/`sudo_run` for the local machine. `host` as `[user@]host[:port]`; `sudo` covers remote POSIX sudo only. For transfer use `action: "file"` with `direction: "upload"|"download"`, `source`, `destination`, optional `recursive` (may overwrite). Use `action: "info"` (no `host` = list aliases, with `host` = its effective config) instead of reading `~/.ssh/config` yourself. Always set `reason`.',
		],

		renderShell: "self",

		// Single Type.Object (root `type: "object"`) rather than Type.Union — a union
		// serializes to `anyOf` with no root type, which strict OpenAI-compatible
		// providers (e.g. DeepSeek) reject with `type: null`. Conditional fields are
		// optional and normalized/validated at runtime via normalizeOperation.
		parameters: Type.Object({
			action: Type.Optional(
				Type.Union([Type.Literal("command"), Type.Literal("file"), Type.Literal("info")], {
					description:
						'"command" (default) runs a remote command; "file" transfers a file/directory; "info" reports SSH config (no connection) — list configured host aliases, or resolve one host\'s effective config when `host` is given.',
				}),
			),
			host: Type.Optional(
				Type.String({
					description:
						"Remote target as `[user@]host[:port]` (e.g. `deploy@10.0.0.5:2222`). Required for command/file; for info, omit to list all aliases or set it to resolve one host.",
				}),
			),
			command: Type.Optional(
				Type.String({
					description:
						'Command sent to the remote host\'s configured SSH shell. Required when action is "command".',
				}),
			),
			sudo: Type.Optional(
				Type.Boolean({
					description:
						"Run the command as root on the remote host via sudo. Default false. Command action only.",
				}),
			),
			direction: Type.Optional(
				Type.Union([Type.Literal("upload"), Type.Literal("download")], {
					description: 'Transfer direction. Required when action is "file".',
				}),
			),
			source: Type.Optional(
				Type.String({
					description:
						'Source path (local for upload, remote for download). Required when action is "file".',
				}),
			),
			destination: Type.Optional(
				Type.String({
					description:
						'Destination path (remote for upload, local for download). Required when action is "file".',
				}),
			),
			recursive: Type.Optional(
				Type.Boolean({
					description: "Copy a directory recursively. Default false. File action only.",
				}),
			),
			reason: Type.Optional(
				Type.String({
					description: "Short plain-English explanation of intent, shown to the user.",
				}),
			),
		}),

		async execute(_toolCallId, params, sig, onUpdate, ctx) {
			// info: read-only SSH config report (no connection, no approval).
			if (params.action === "info") {
				return infoResult(params.host, sig);
			}

			if (!params.host?.trim()) {
				return {
					content: [{ type: "text", text: "ssh_run failed: host is required" }],
					details: makeDetails("", "", false, params.reason, {
						outcome: "error",
						errorKind: "execution",
					}),
					isError: true,
				};
			}
			const operation = normalizeOperation(params);
			const { action, command, destination, direction, reason, recursive, source, sudo } =
				operation;

			if (action === "file" && (!source || !destination)) {
				return {
					content: [{ type: "text", text: "ssh_run failed: source and destination are required" }],
					details: makeDetails(command, params.host, false, reason, {
						outcome: "error",
						errorKind: "execution",
					}),
					isError: true,
				};
			}

			if (action === "command" && !command.trim()) {
				return {
					content: [{ type: "text", text: "ssh_run failed: command is required" }],
					details: makeDetails(command, params.host, sudo, reason, {
						outcome: "error",
						errorKind: "execution",
					}),
					isError: true,
				};
			}

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

			const mode = getUnattendedMode(pi.events);
			const yolo = mode === "yolo";
			if (action === "command" && mode === "afk") {
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
			const transferDecision =
				action === "file" ? transferApprovalDecision(mode, needLogin) : "ask";
			if (transferDecision === "deny") {
				return {
					content: [
						{
							type: "text",
							text: "ssh_run file transfer denied — unattended mode cannot enter a missing SSH login password.",
						},
					],
					details: makeDetails(command, host, false, reason, {
						outcome: "denied",
						cancellationKind: "denied",
					}),
				};
			}

			const body = [
				...approvalBody(operation, host, spec.port),
				...(keyOk && !creds.loginPassword ? ["Auth: SSH key (no password)"] : []),
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
			const privileged = action === "command" && (sudo || commandEscalatesPrivilege(command));
			const alreadyApproved =
				action === "command" &&
				!privileged &&
				hostApproved(approvedHosts, key) &&
				promptFor.length === 0;
			if (alreadyApproved) {
				ctx.ui.notify(`ssh_run: reused session approval for ${host}`, "info");
			} else if (transferDecision === "allow") {
				ctx.ui.notify(
					`⚠ ssh_run file transfer auto-approved — ${mode.toUpperCase()} warning policy`,
					"warning",
				);
			}

			const runOverlay = (): Promise<OverlayResult> =>
				withAgentBlock(pi.events, "ssh_run", "SSH approval required", async () => {
					if ((transferDecision === "allow" || yolo || alreadyApproved) && promptFor.length === 0) {
						return { action: "approved", password: "" } as OverlayResult;
					}
					// Confirm-only when no password is missing.
					if (promptFor.length === 0) {
						return showOverlay(ctx.ui, {
							mode: "confirm",
							title:
								action === "file"
									? `⚠ SSH ${direction === "download" ? "DOWNLOAD" : "UPLOAD"}`
									: "🔐 SSH COMMAND REQUEST",
							body,
							accent: sudo ? "error" : action === "file" ? "warning" : "accent",
							timeoutMs: PROMPT_TIMEOUT_MS,
							choices: [
								{
									value: "yes",
									label: "Allow",
									description:
										action === "file" ? "Copy to destination (may overwrite)" : "Run the command",
								},
								{
									value: "no",
									label: "Deny",
									description: action === "file" ? "Cancel transfer" : "Block the command",
								},
							],
						});
					}
					// One masked prompt per missing password, in order.
					let last: OverlayResult = { action: "approved", password: "" };
					for (const stage of promptFor) {
						const label = stage === "login" ? "SSH login password" : "Remote sudo password";
						last = await showOverlay(ctx.ui, {
							mode: "sudo",
							title:
								action === "file"
									? `⚠ SSH ${direction === "download" ? "DOWNLOAD" : "UPLOAD"}`
									: "🔐 SSH COMMAND REQUEST",
							body: [...body, `Enter: ${label}`],
							accent: sudo ? "error" : action === "file" ? "warning" : "accent",
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

			// File transfers remain warning-level: normal mode asks every time,
			// AFK denies above, and YOLO may approve when no password is missing.
			if (action === "command") approvedHosts.set(key, Date.now() + APPROVAL_TTL_MS);

			// Persist newly-entered passwords in the session cache.
			const loginPassword = creds.loginPassword ?? collected.login;
			const sudoPassword = creds.sudoPassword ?? collected.sudo;
			credCache.set(key, {
				...(loginPassword ? { loginPassword } : {}),
				...(sudoPassword ? { sudoPassword } : {}),
			});

			let spinnerFrame = 0;
			const updateTransferPresentation = () => {
				const verb = direction === "download" ? "Downloading from" : "Uploading to";
				updatePresentation(
					onUpdate,
					command,
					host,
					sudo,
					reason,
					"running",
					`${SPINNER[spinnerFrame] ?? ""} ${verb} ${host}…`,
				);
			};
			if (action === "file") updateTransferPresentation();
			else updatePresentation(onUpdate, command, host, sudo, reason, "running");
			// ponytail: spinner shows liveness only; SCP has no stable byte-progress API.
			// Use an SFTP client with byte callbacks if percentage progress is needed.
			const spinnerTimer =
				action === "file" && onUpdate
					? setInterval(() => {
							spinnerFrame = (spinnerFrame + 1) % SPINNER.length;
							updateTransferPresentation();
						}, SPINNER_INTERVAL_MS)
					: undefined;

			let result: { stdout: string; stderr: string; code: number } | undefined;
			try {
				result =
					action === "file"
						? await runTransfer(spec, direction ?? "upload", source, destination, recursive, {
								controlPath,
								...(loginPassword ? { loginPassword } : {}),
								...(sig ? { signal: sig } : {}),
							})
						: await runSsh(spec, command, {
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
			} finally {
				if (spinnerTimer) clearInterval(spinnerTimer);
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

		renderCall: ((args: SshParams, theme: ThemeLike, renderCtx: RenderContextLike) => {
			resolveBaseBackground(theme);
			const text = renderCtx.lastComponent ?? new Text("", 0, 0);
			if (
				hideCollapsedToolCall(renderCtx.state as CollapseState, renderCtx.expanded, (value) =>
					text.setText(value),
				)
			)
				return text;

			const host = safeOneLine(args.host ?? "");
			if (args.action === "info") {
				text.setText(
					fillToolBackground(
						`${theme.fg("toolTitle", theme.bold("ssh info"))} ${theme.fg("dim", host || "list aliases")}`,
					),
				);
				return text;
			}
			const operation = normalizeOperation(args);
			const command = safeOneLine(operation.command) || "(empty command)";
			const prefix = operation.sudo ? "sudo " : "";
			text.setText(
				fillToolBackground(
					`${theme.fg("toolTitle", theme.bold(operation.action === "file" ? "ssh file" : "ssh"))} ${theme.fg("dim", host)} ${theme.fg("muted", prefix + command)}`,
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
			const details = result.details as SshResultDetails | undefined;
			const isPartial = (_opt as { isPartial?: boolean } | undefined)?.isPartial === true;
			const completed = (isError: boolean) => frameToolResult(text, theme, isError);

			if (details?._type !== "sshResult") {
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
					"ssh",
					renderCtx.state as CollapseState,
					renderCtx.invalidate,
					renderCtx.expanded,
				)
			) {
				const status = details.outcome === "success" ? "success" : "error";
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
