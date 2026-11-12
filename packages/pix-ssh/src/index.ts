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
 * re-auth. `fresh: true` stops that master first, and every result reports the
 * auth method (key/password) and whether the connection was new or reused.
 *
 * Security notes:
 *   - Passwords never leave JS memory; never written to disk; never in argv.
 *   - File transfers are warning-level and show their overwrite risk in the UI.
 *   - No UI (RPC / JSON mode) = blocked immediately.
 *   - Output truncated to 50 KB / 2000 lines.
 *
 * Layout: operation.ts (params → operation), auth.ts (credentials, probes),
 * result.ts (details), info.ts (info action), render.ts (tool card), this file
 * (registration and the approval → run pipeline).
 */

import {
	type OverlayChoice,
	type OverlayResult,
	type OverlayUI,
	showOverlay,
} from "@xynogen/pix-pretty/gate-overlay";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { getErrorMessage, normalizeLineEndings } from "@xynogen/pix-pretty/utils";
import { SPINNER } from "@xynogen/pix-pretty/widget-format";
import { getUnattendedMode, type UnattendedMode } from "@xynogen/pix-runtime";
import { editSchema } from "@xynogen/pix-runtime/files";
import type { AgentToolUpdateCallback, EventBus, ExtensionAPI } from "@xynogen/pix-runtime/host";
import { once } from "@xynogen/pix-runtime/once";
import { truncateOutput } from "@xynogen/pix-runtime/output";
import { runToolExecution } from "@xynogen/pix-runtime/tool-execution";
import { Type } from "typebox";
import {
	authVia,
	cacheKey,
	credCache,
	type HostCreds,
	keyRecheckAt,
	prepareConnection,
	probeConnection,
	validatorFor,
} from "./auth.ts";
import { infoResult } from "./info.ts";
import {
	closeMaster,
	commandEscalatesPrivilege,
	controlPathFor,
	detectHostKeyFailure,
	detectSshFailure,
	detectSudoFailure,
	HostKeyError,
	type HostSpec,
	hostKeyReset,
	hostTarget,
	MAX_OUTPUT_BYTES,
	MAX_OUTPUT_LINES,
	parseHost,
	type probeKeyAuth,
	probeSudoNoPassword,
	resetKnownHost,
	resolveSshHost,
	runFile,
	runSsh,
	runTransfer,
	type SshResult,
	transferApprovalDecision,
} from "./lib.ts";
import {
	approvalBody,
	approvalTitle,
	isFileAction,
	missingSshTools,
	normalizeOperation,
	type SshOperation,
	type SshParams,
	validateFile,
} from "./operation.ts";
import { renderSshCall, renderSshResult } from "./render.ts";
import {
	cancelResult,
	makeDetails,
	outputLineCount,
	type SshDetailFields,
	type SshResultDetails,
	updatePresentation,
} from "./result.ts";

export { validatorFor } from "./auth.ts";
export { missingSshTools } from "./operation.ts";
export type { SshResultDetails } from "./result.ts";

const PROMPT_TIMEOUT_MS = 60_000;
const MAX_PASSWORD_ATTEMPTS = 3;
const SPINNER_INTERVAL_MS = 120;

/** "Allow for this session" choice. Offered only for non-privileged commands. */
const SESSION_CHOICE: OverlayChoice[] = [
	{ value: "session", label: "Allow for this session", description: "Host, until /new; sudo asks" },
];

type ToolText = { type: "text"; text: string };
type SshToolResult = {
	content: ToolText[];
	details: SshResultDetails | undefined;
	isError?: boolean;
	structuredContent?: string;
};

/** Per-call state shared by the approval and run steps. */
interface Call {
	params: SshParams;
	operation: SshOperation;
	fileAction: boolean;
	spec: HostSpec;
	host: string;
	controlPath: string;
	key: string;
	creds: HostCreds;
	mode: UnattendedMode;
	ui: OverlayUI & { notify(message: string, type?: "info" | "warning" | "error"): void };
	events: EventBus;
	sessionHosts: Set<string>;
	sig?: AbortSignal;
}

function fail(
	call: Pick<SshOperation, "command" | "sudo" | "reason">,
	host: string,
	text: string,
	fields: SshDetailFields = { outcome: "error", errorKind: "execution" },
): SshToolResult {
	return {
		content: [{ type: "text", text }],
		details: makeDetails(call.command, host, call.sudo, call.reason, fields),
		...(fields.outcome === "error" ? { isError: true } : {}),
	};
}

/** Input checks that need no connection. Returns a failure, or undefined to continue. */
async function validateInput(
	params: SshParams,
	operation: SshOperation,
): Promise<SshToolResult | undefined> {
	const host = params.host ?? "";
	if (operation.action === "file" && (!operation.source || !operation.destination))
		return fail(
			{ ...operation, sudo: false },
			host,
			"ssh_run failed: source and destination are required",
		);
	if (operation.action === "command" && !operation.command.trim())
		return fail(operation, host, "ssh_run failed: command is required");
	// Fail up front with pix's install hint: the probes below treat a spawn
	// error as "unreachable", which would hide a missing ssh/scp.
	const missingTool = missingSshTools(operation.action);
	if (missingTool) return fail(operation, host, `ssh_run failed: ${missingTool}`);
	return undefined;
}

/** Show the host-key-changed modal; reset known_hosts only after explicit verification. */
async function handleHostKeyError(
	call: Call,
	error: HostKeyError,
): Promise<SshToolResult | undefined> {
	const { spec, host, controlPath, key, sig } = call;
	const reset = hostKeyReset(error.stderr);
	const diagnostic = `${error.message}\n\nVerify the new fingerprint with the host owner or physical console. A reinstall can change it, but this can also indicate an attack. Do not enter a password until verified.`;
	const decision = await showOverlay(call.ui, {
		state: { events: call.events, source: "ssh_run" },
		signal: sig,
		mode: "confirm",
		icon: icon("warn"),
		accent: "error",
		title: "SSH HOST KEY CHANGED — verify before resetting",
		body: [
			`Host: ${host}`,
			...diagnostic.split("\n"),
			...(reset
				? [
						`Reset target: ${reset.host}`,
						`File: ${reset.file} (backup: ${reset.file}.old)`,
						"Only reset if you independently verified the fingerprint above.",
					]
				: ["Automatic reset is unavailable. Resolve the host key error manually."]),
		],
		timeoutMs: PROMPT_TIMEOUT_MS,
		approveValue: "reset",
		choices: [
			{ value: "cancel", label: "Cancel", description: "Keep known_hosts unchanged" },
			...(reset
				? [
						{
							value: "reset",
							label: "Reset known host and reconnect",
							description: "I verified the new fingerprint through a trusted source",
						},
					]
				: []),
		],
	});
	sig?.throwIfAborted();
	let message = `${diagnostic}\n\nReset cancelled. known_hosts was not changed by pix-ssh.`;
	if (decision.action === "approved" && decision.choice === "reset" && reset) {
		try {
			await resetKnownHost(spec, reset, sig);
			await closeMaster(spec, controlPath, sig);
			credCache.delete(key);
			keyRecheckAt.delete(key);
			call.sessionHosts.delete(key);
			call.creds = {};
			call.ui.notify(`ssh_run: verified host key reset for ${host}`, "info");
			return undefined;
		} catch (resetError) {
			sig?.throwIfAborted();
			message = `${diagnostic}\n\nHost key reset failed: ${getErrorMessage(resetError)}`;
		}
	}
	return fail(call.operation, host, message, { outcome: "error", errorKind: "host-key" });
}

type Probe = Awaited<ReturnType<typeof probeKeyAuth>>;

/** Honor `fresh`, re-check the key, then probe auth. A changed host key gets one reset-and-retry. */
async function connect(
	call: Call,
): Promise<SshToolResult | { probe: Probe; connection: "new" | "reused" }> {
	const { spec, controlPath, sig, fileAction } = call;
	try {
		const prep = await prepareConnection(
			spec,
			controlPath,
			call.key,
			call.creds,
			call.params.fresh,
			sig,
			fileAction,
		);
		call.creds = prep.creds;
		// Cached passwords still need an identity check when their master has expired.
		const probe = await probeConnection(spec, controlPath, sig, fileAction);
		return { probe, connection: prep.connection };
	} catch (error) {
		if (!(error instanceof HostKeyError)) throw error;
		const failure = await handleHostKeyError(call, error);
		if (failure) return failure;
		try {
			return {
				probe: await probeConnection(spec, controlPath, sig, fileAction),
				connection: "new",
			};
		} catch (retryError) {
			if (!(retryError instanceof HostKeyError)) throw retryError;
			return fail(call.operation, call.host, retryError.message, {
				outcome: "error",
				errorKind: "host-key",
			});
		}
	}
}

interface Approval {
	/** Passwords the overlay must still collect, login first. */
	promptFor: ("login" | "sudo")[];
	transferDecision: "ask" | "allow" | "deny";
	alreadyApproved: boolean;
	privileged: boolean;
	keyOk: boolean;
}

/** Decide which prompts this call needs. */
async function planApproval(call: Call, probe: Probe): Promise<Approval> {
	const { operation, creds } = call;
	const { action, sudo, command } = operation;
	// Only prompt for a login password when the host is reachable but rejects
	// key auth ("auth"). If it's unreachable (timeout/DNS/refused) a password
	// can't help — skip the prompt and let runSsh surface the real error.
	const keyOk = probe === "ok";
	const needLogin = probe === "auth" && !creds.loginPassword;
	// Remote sudo password only when NOT already cached, NOT NOPASSWD, and
	// the SSH connection is passwordless (so the probe can open its own
	// channel without prompting). When login still needs a password we
	// can't probe yet, so fall back to prompting for the sudo password.
	const sudoNoPassword =
		sudo && !creds.sudoPassword && !needLogin && (keyOk || Boolean(creds.loginPassword))
			? await probeSudoNoPassword(call.spec, call.controlPath, call.sig)
			: false;
	const needSudo = sudo && !creds.sudoPassword && !sudoNoPassword;
	// Session allow-memory: host already approved + no password missing → skip
	// the confirm overlay entirely (visible notify). Privileged commands
	// (sudo:true, or a sudo/su/doas/pkexec token in the command text) are never
	// auto-approved — they always re-confirm.
	const promptFor: Approval["promptFor"] = [
		...(needLogin ? (["login"] as const) : []),
		...(needSudo ? (["sudo"] as const) : []),
	];
	const privileged = action === "command" && (sudo || commandEscalatesPrivilege(command));
	return {
		promptFor,
		transferDecision: action === "file" ? transferApprovalDecision(call.mode, needLogin) : "ask",
		alreadyApproved:
			action === "command" &&
			!privileged &&
			call.sessionHosts.has(call.key) &&
			promptFor.length === 0,
		privileged,
		keyOk,
	};
}

/** Run the confirm and password overlays. Collected passwords land in `collected`. */
async function runOverlay(
	call: Call,
	approval: Approval,
	collected: { login?: string; sudo?: string },
): Promise<OverlayResult> {
	const { operation, host, spec, sig } = call;
	const { action, sudo } = operation;
	const { promptFor, transferDecision, alreadyApproved, privileged } = approval;
	const yolo = call.mode === "yolo" || call.mode === "nuclear";
	if ((transferDecision === "allow" || yolo || alreadyApproved) && promptFor.length === 0) {
		return { action: "approved", password: "" };
	}
	const title = approvalTitle(operation);
	const body = [
		...approvalBody(operation, host, spec.port),
		...(approval.keyOk && !call.creds.loginPassword ? ["Auth: SSH key (no password)"] : []),
	];
	const sessionChoices = action === "command" && !privileged ? SESSION_CHOICE : [];
	const common = {
		state: { events: call.events, source: "ssh_run" },
		signal: sig,
		icon: action === "file" ? icon("warn") : icon("lock"),
		title,
		accent: sudo ? "error" : action === "file" ? "warning" : "accent",
		timeoutMs: PROMPT_TIMEOUT_MS,
		approveValue: ["yes", "session"],
	} as const;
	// Confirm-only when no password is missing.
	if (promptFor.length === 0) {
		return showOverlay(call.ui, {
			...common,
			mode: "confirm",
			body,
			choices: [
				{
					value: "yes",
					label: "Allow",
					description:
						action === "file" ? "Copy to destination (may overwrite)" : "Run the command",
				},
				...sessionChoices,
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
		last = await showOverlay(call.ui, {
			...common,
			mode: "sudo",
			body: [...body, `Enter: ${label}`],
			maxPasswordAttempts: MAX_PASSWORD_ATTEMPTS,
			passwordLabel: `${label}:`,
			// Login stage: actually test the password against the host so a
			// wrong one re-prompts (up to MAX_PASSWORD_ATTEMPTS), mirroring
			// pix-sudo. Sudo stage can't be validated until login succeeds, so
			// it keeps the non-empty check and surfaces failures on the run.
			validatePassword: validatorFor(stage, spec, call.controlPath, sig, call.fileAction),
			choices: [
				{ value: "yes", label: "Allow", description: `Enter ${label.toLowerCase()}` },
				...sessionChoices,
				{ value: "no", label: "Deny", description: "Block the command" },
			],
		});
		if (last.action !== "approved" || !last.password?.trim()) return last;
		if (stage === "login") collected.login = last.password;
		else collected.sudo = last.password;
	}
	return last;
}

/** Map a finished command or transfer to its tool result. */
function commandResult(
	call: Call,
	result: SshResult,
	via: ReturnType<typeof authVia>,
	loginPassword: string | undefined,
): SshToolResult {
	const { operation, host, key } = call;
	const { sudo } = operation;
	// SSH auth failure → drop the bad login password from the cache so the next call re-prompts.
	if (detectSshFailure(result.code, result.stderr)) {
		credCache.delete(key);
		return fail(operation, host, `SSH authentication failed:\n${result.stderr}`, {
			outcome: "error",
			exitCode: result.code,
			lineCount: outputLineCount(result.stderr),
			errorKind: "auth-ssh",
			_render: normalizeLineEndings(result.stderr),
		});
	}
	// Remote sudo password failure → drop the bad sudo password.
	if (sudo && detectSudoFailure(result.stderr)) {
		credCache.set(key, loginPassword ? { loginPassword } : {});
		return fail(operation, host, `Remote sudo authentication failed:\n${result.stderr}`, {
			outcome: "error",
			exitCode: result.code,
			...via,
			lineCount: outputLineCount(result.stderr),
			errorKind: "auth-sudo",
			_render: normalizeLineEndings(result.stderr),
		});
	}

	const combined = [result.stdout, result.stderr].filter(Boolean).join("\n") || "(no output)";
	const { text: truncatedText, truncated } = truncateOutput(combined);
	const suffix = truncated
		? `\n\n[Output truncated to ${MAX_OUTPUT_LINES} lines / ${MAX_OUTPUT_BYTES / 1024}KB]`
		: "";
	const rendered = normalizeLineEndings(combined)
		.replace(/\n{3,}/g, "\n\n")
		.replace(/^\n+|\n+$/g, "");
	return {
		content: [
			{
				type: "text",
				text: `Exit code: ${result.code} (auth: ${via.auth}, ${via.connection} connection)\n\n${truncatedText}${suffix}`,
			},
		],
		details: makeDetails(operation.command, host, sudo, operation.reason, {
			outcome: result.code === 0 ? "success" : "error",
			exitCode: result.code,
			...via,
			lineCount: outputLineCount(rendered),
			truncated,
			...(result.code === 0 ? {} : { errorKind: "exit-code" as const }),
			_render: rendered,
		}),
		isError: result.code !== 0,
	};
}

/** Approved: run the operation with progress updates and map its result. */
function runApproved(
	call: Call,
	connection: "new" | "reused",
	onUpdate: AgentToolUpdateCallback<SshResultDetails> | undefined,
) {
	const { operation, host, spec, controlPath, sig, params } = call;
	const { action, command, sudo, reason, direction, source, destination, recursive } = operation;
	const loginPassword = call.creds.loginPassword;
	const sudoPassword = call.creds.sudoPassword;
	const via = authVia(loginPassword, connection);
	const hasUpdates = Boolean(onUpdate);
	return runToolExecution({
		signal: sig,
		onUpdate,
		onError: (error, cancelled) => ({
			content: [
				{
					type: "text" as const,
					text: cancelled ? "ssh_run cancelled." : `ssh_run failed: ${getErrorMessage(error)}`,
				},
			],
			details: makeDetails(
				command,
				host,
				sudo,
				reason,
				cancelled
					? { outcome: "cancelled", cancellationKind: "aborted" }
					: { outcome: "error", errorKind: "execution" },
			),
			isError: !cancelled,
		}),
		execute: async ({ update, onCleanup }): Promise<SshToolResult> => {
			let spinnerFrame = 0;
			const updateTransferPresentation = () => {
				const verb = direction === "download" ? "Downloading from" : "Uploading to";
				updatePresentation(
					update,
					command,
					host,
					sudo,
					reason,
					"running",
					`${SPINNER[spinnerFrame] ?? ""} ${verb} ${host}…`,
				);
			};
			if (action === "file") updateTransferPresentation();
			else updatePresentation(update, command, host, sudo, reason, "running");
			// ponytail: spinner shows liveness only; SCP has no stable byte-progress API.
			// Use an SFTP client with byte callbacks if percentage progress is needed.
			const spinnerTimer =
				action === "file" && hasUpdates
					? setInterval(() => {
							spinnerFrame = (spinnerFrame + 1) % SPINNER.length;
							updateTransferPresentation();
						}, SPINNER_INTERVAL_MS)
					: undefined;
			onCleanup(() => clearInterval(spinnerTimer));

			if (call.fileAction) {
				const result = await runFile(
					spec,
					action as "read" | "write" | "edit",
					{
						path: params.path!,
						content: params.content,
						edits: params.edits,
						offset: params.offset,
						limit: params.limit,
					},
					{ controlPath, loginPassword, signal: sig },
				);
				return {
					content: [{ type: "text", text: result.stdout }],
					structuredContent: result.stdout,
					details: makeDetails(command, host, false, reason, {
						outcome: "success",
						exitCode: 0,
						...via,
						lineCount: outputLineCount(result.stdout),
						_render: result.stdout,
					}),
				};
			}
			const result =
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

			if (result.code !== 0 && detectHostKeyFailure(result.stderr)) {
				const failure = await handleHostKeyError(call, new HostKeyError(result.stderr));
				return (
					failure ?? {
						content: [
							{
								type: "text",
								text: "Host key reset. Retry the SSH operation; the command or transfer was not rerun.",
							},
						],
						details: makeDetails(command, host, sudo, reason, { outcome: "cancelled" }),
					}
				);
			}
			return commandResult(call, result, via, loginPassword);
		},
	});
}

async function execute(
	params: SshParams,
	sig: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<SshResultDetails> | undefined,
	ctx: { hasUI: boolean; ui: Call["ui"] },
	events: EventBus,
	sessionHosts: Set<string>,
) {
	sig?.throwIfAborted();
	// info: read-only SSH config report (no connection, no approval).
	if (params.action === "info") return infoResult(params.host, sig);

	if (!params.host?.trim())
		return fail(
			{ command: "", sudo: false, reason: params.reason },
			"",
			"ssh_run failed: host is required",
		);
	const fileAction = isFileAction(params.action);
	if (fileAction) {
		try {
			await validateFile(params);
		} catch (error) {
			return {
				content: [{ type: "text" as const, text: `ssh_run failed: ${getErrorMessage(error)}` }],
				isError: true,
				details: undefined,
			};
		}
	}
	const operation = normalizeOperation(params);
	const invalid = await validateInput(params, operation);
	if (invalid) return invalid;

	let spec: HostSpec;
	try {
		spec = parseHost(params.host);
	} catch (err) {
		return fail(operation, params.host, `ssh_run failed: ${getErrorMessage(err)}`);
	}
	// ponytail: let OpenSSH own config parsing; `ssh -G` handles aliases,
	// Include, and Match rules without duplicating its config grammar.
	const effectiveSpec = await resolveSshHost(spec, sig);
	const host = hostTarget(effectiveSpec);
	const key = cacheKey(effectiveSpec);
	const mode = getUnattendedMode(events);
	if ((operation.action === "command" || fileAction) && mode === "afk")
		return fail(operation, host, "ssh_run denied immediately — AFK mode is active.", {
			outcome: "denied",
			cancellationKind: "denied",
		});
	if (!ctx.hasUI)
		return fail(operation, host, "ssh_run requires an interactive session (no UI available).", {
			outcome: "error",
			errorKind: "no-ui",
		});

	updatePresentation(
		onUpdate,
		operation.command,
		host,
		operation.sudo,
		operation.reason,
		"awaiting-approval",
	);
	// Keep original target for execution so alias-specific IdentityFile,
	// ProxyJump, and other SSH config options still apply.
	const call: Call = {
		params,
		operation,
		fileAction,
		spec,
		host,
		controlPath: controlPathFor(effectiveSpec),
		key,
		creds: credCache.get(key) ?? {},
		mode,
		ui: ctx.ui,
		events,
		sessionHosts,
		sig,
	};

	const connected = await connect(call);
	if ("content" in connected) return connected;
	const approval = await planApproval(call, connected.probe);
	if (approval.transferDecision === "deny")
		return fail(
			{ ...operation, sudo: false },
			host,
			"ssh_run file transfer denied — unattended mode cannot enter a missing SSH login password.",
			{ outcome: "denied", cancellationKind: "denied" },
		);
	if (approval.alreadyApproved)
		ctx.ui.notify(`ssh_run: reused session approval for ${host}`, "info");
	else if (approval.transferDecision === "allow")
		ctx.ui.notify(
			`⚠ ssh_run file transfer auto-approved — ${mode.toUpperCase()} warning policy`,
			"warning",
		);

	const collected: { login?: string; sudo?: string } = {};
	const overlayResult = await runOverlay(call, approval, collected);
	sig?.throwIfAborted();
	if (overlayResult.passwordAttemptsExhausted)
		return fail(
			operation,
			host,
			`SSH authentication failed after ${MAX_PASSWORD_ATTEMPTS} attempts — wrong password.`,
			{ outcome: "error", errorKind: "auth-ssh" },
		);
	const needLogin = approval.promptFor.includes("login");
	const needSudo = approval.promptFor.includes("sudo");
	const missing =
		overlayResult.action === "approved" &&
		((needLogin && !collected.login) || (needSudo && !collected.sudo));
	if (overlayResult.action !== "approved" || missing)
		return cancelResult(
			operation.command,
			host,
			operation.sudo,
			operation.reason,
			overlayResult.action,
		);

	// Plain "Allow" approves this call only. "session" (offered only for
	// non-privileged commands) is the sole way to skip later prompts.
	if (overlayResult.choice === "session") {
		sessionHosts.add(key);
		ctx.ui.notify(`ssh_run: ${host} allowed for this session (sudo still asks)`, "info");
	}

	// Persist newly-entered passwords in the session cache.
	const loginPassword = call.creds.loginPassword ?? collected.login;
	const sudoPassword = call.creds.sudoPassword ?? collected.sudo;
	call.creds = {
		...(loginPassword ? { loginPassword } : {}),
		...(sudoPassword ? { sudoPassword } : {}),
	};
	credCache.set(key, call.creds);
	return runApproved(call, connected.connection, onUpdate);
}

export default function pixSsh(pi: ExtensionAPI): void {
	once(pi, "pix-ssh", () => register(pi));
}

function register(pi: ExtensionAPI): void {
	// "Allow for this session" hosts. Lives in the factory: Pi hands each new session a fresh `pi`,
	// so this resets on /new. Privileged commands never use it (see planApproval).
	const sessionHosts = new Set<string>();
	pi.registerTool({
		name: "ssh_run",
		...({ exposure: "deferred" } as const),
		label: "Run over SSH",
		description:
			"Operate on a REMOTE host over SSH (for the LOCAL machine use `bash`, or `sudo_run` for local root). " +
			"Pick one `action`; each has its own parameters:\n" +
			"- command: run a command. Required: host, command. Optional: sudo (remote POSIX root).\n" +
			"- upload/download: transfer a file or directory (may overwrite the destination). Required: host, source, destination. Optional: recursive.\n" +
			"- read: read remote UTF-8 text with edit anchors. Required: host, path. Optional: offset, limit.\n" +
			"- write: create or replace remote UTF-8 text. Required: host, path, content.\n" +
			"- edit: change remote text with the same hash-anchor or exact-text edits as local edit. Required: host, path, edits.\n" +
			"- info: read SSH config, no connection. Optional: host (omit = list aliases, set = effective config).\n" +
			"Always set `reason`. File actions use SFTP, not the remote shell; they run as the SSH user (no sudo). Text files must be regular UTF-8 files, at most 50MB; symlinks are rejected. Replacement preserves permission bits, not ownership, ACLs or hard links. Paths use /, Windows drive paths may use C:/ or /C:/. Relative paths start at the SFTP home. command on Windows/PowerShell remains best-effort.",
		promptSnippet: "Run a remote command, transfer files, or read SSH config over SSH",
		promptGuidelines: [
			'ssh_run: REMOTE host only — use `bash`/`sudo_run` locally. `action` is required: "command" (host, command, sudo?), "upload" or "download" (host, source, destination, recursive?), "info" (host? — no host = list aliases). `host` is `[user@]host[:port]`. Use "info" instead of reading `~/.ssh/config`. Always set `reason`. Load read_skills(name="pix-ssh", full=true) for patterns.',
			"For remote files use read/write/edit, not shell cat/sed/PowerShell. read returns LINE#HASH anchors for edit; write replaces the whole file. Never reuse anchors from another host or file.",
		],

		renderShell: "self",

		// Single flat Type.Object (root `type: "object"`) rather than Type.Union — a union
		// serializes to `anyOf` with no root type, which strict OpenAI-compatible
		// providers (e.g. DeepSeek) reject with `type: null`. Only `action` is
		// schema-required; per-action fields are tagged in their descriptions and
		// validated at runtime via normalizeOperation.
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("command"),
					Type.Literal("upload"),
					Type.Literal("download"),
					Type.Literal("info"),
					Type.Literal("read"),
					Type.Literal("write"),
					Type.Literal("edit"),
				],
				{
					description:
						'"command" runs a remote command, "upload" copies local to remote, "download" copies remote to local, "info" reads SSH config (no connection).',
				},
			),
			host: Type.Optional(
				Type.String({
					description:
						"`[user@]host[:port]`, e.g. `deploy@10.0.0.5:2222`. REQUIRED except for info: omit to list aliases, set to resolve one host.",
				}),
			),
			// command
			command: Type.Optional(
				Type.String({
					description: "[command] REQUIRED. Sent to the remote host's configured SSH shell.",
				}),
			),
			sudo: Type.Optional(
				Type.Boolean({
					description: "[command] Optional, default false. Run as root on the remote via sudo.",
				}),
			),
			path: Type.Optional(
				Type.String({
					minLength: 1,
					description:
						"[read|write|edit] REQUIRED. Remote SFTP path; use forward slashes. Relative to remote home, not local cwd.",
				}),
			),
			content: Type.Optional(
				Type.String({
					description:
						"[write] REQUIRED. Full UTF-8 file content, including an empty string to clear it.",
				}),
			),
			offset: Type.Optional(
				Type.Integer({ minimum: 1, description: "[read] Starting line, default 1." }),
			),
			limit: Type.Optional(
				Type.Integer({
					minimum: 1,
					description: "[read] Line limit, default 400; output capped at 2,000 lines/50KB.",
				}),
			),
			edits: Type.Optional(editSchema.properties.edits),
			// file
			source: Type.Optional(
				Type.String({
					description:
						"[upload|download] REQUIRED. Local path for upload, remote path for download.",
				}),
			),
			destination: Type.Optional(
				Type.String({
					description:
						"[upload|download] REQUIRED. Remote path for upload, local path for download.",
				}),
			),
			recursive: Type.Optional(
				Type.Boolean({
					description: "[upload|download] Optional, default false. Copy a directory recursively.",
				}),
			),
			fresh: Type.Optional(
				Type.Boolean({
					description:
						"[command|upload|download] Optional, default false. Close the reused connection first so this call re-authenticates (e.g. to prove key login).",
				}),
			),
			reason: Type.String({
				description: "Short plain-English intent, shown to the user as the approval title.",
			}),
		}),

		execute: (_toolCallId, params, sig, onUpdate, ctx) =>
			execute(params, sig, onUpdate, ctx, pi.events, sessionHosts),
		renderCall: renderSshCall,
		renderResult: renderSshResult,
	});
}
