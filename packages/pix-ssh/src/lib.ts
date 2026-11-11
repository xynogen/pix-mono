/**
 * Pure / side-effect-free helpers for pix-ssh, extracted so they can be
 * unit-tested without opening real SSH connections or loading the Pi host.
 *
 * Security model:
 *   - SSH login password (when key auth fails) is fed to `sshpass -e` via the
 *     SSHPASS env var of the child only — never as an argv (no `ps` leak),
 *     never written to disk.
 *   - Remote sudo password is piped to the remote `sudo -S -p ''` on stdin,
 *     so it travels inside the encrypted SSH channel, not as an argv.
 *   - ControlMaster multiplexing means one authenticated connection per host
 *     is reused by later calls (ControlPersist window), so the password is
 *     entered once per session per host.
 */

import { isAbsolute, join, resolve as resolvePath } from "node:path";
import type { UnattendedMode } from "@xynogen/pix-runtime";
import { writeFileAtomicSync } from "@xynogen/pix-runtime/atomic-write";
import { createHash } from "@xynogen/pix-runtime/crypto";
import { runTool } from "@xynogen/pix-runtime/exec";
import { type EditInput, editText, readText, writeText } from "@xynogen/pix-runtime/files";
import { globSync, mkdtempSync, readFileSync, rmSync, statSync } from "@xynogen/pix-runtime/fs";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@xynogen/pix-runtime/host";
import { expandHome, homeDir, tempDir } from "@xynogen/pix-runtime/paths";
import { runSftp, sftpPath, withSftp } from "@xynogen/pix-runtime/sftp";

// Pi's own tool-output limits (50KB / 2000 lines), so every tool caps the same way.
export const MAX_OUTPUT_BYTES = DEFAULT_MAX_BYTES;
export const MAX_OUTPUT_LINES = DEFAULT_MAX_LINES;

/**
 * True when the command text itself escalates privilege (sudo/su/doas/pkexec),
 * so per-host allow-memory must NOT auto-approve it even when `sudo:true` was
 * not passed. Word-boundary match; catches leading and mid-chain occurrences
 * (`… && sudo …`).
 */
export function commandEscalatesPrivilege(command: string): boolean {
	return /(^|[\s;&|(])(sudo|su|doas|pkexec)\b/.test(command);
}

/** ControlPersist window (seconds) — the multiplexed connection lingers this
 * long after the last call, so repeat commands skip re-auth. */
const CONTROL_PERSIST_SECONDS = 120;
const CONNECT_TIMEOUT_SECONDS = 10;

export interface HostSpec {
	user?: string;
	host: string;
	port?: number;
}

export interface SshResult {
	stdout: string;
	stderr: string;
	code: number;
}

export type TransferDirection = "upload" | "download";
export type { UnattendedMode } from "@xynogen/pix-runtime";

/** Warning-level transfer policy. Password prompts cannot run unattended. */
export function transferApprovalDecision(
	mode: UnattendedMode,
	loginPasswordMissing: boolean,
): "ask" | "allow" | "deny" {
	if (mode === "nuclear") return loginPasswordMissing ? "ask" : "allow";
	if (mode === "off") return "ask";
	return loginPasswordMissing ? "deny" : "allow";
}

// ── Host parsing ─────────────────────────────────────────────────────────────

/** Parse `[user@]host[:port]` into parts. Throws on empty host. */
export function parseHost(spec: string): HostSpec {
	const trimmed = spec.trim();
	if (!trimmed) throw new Error("Empty host");

	let user: string | undefined;
	let rest = trimmed;
	const at = rest.lastIndexOf("@");
	if (at !== -1) {
		user = rest.slice(0, at) || undefined;
		rest = rest.slice(at + 1);
	}

	let port: number | undefined;
	// IPv6 literals use brackets: [::1]:22 — only split a port off the tail
	// when there is exactly one colon (plain host:port), leaving bare IPv6 alone.
	const colons = rest.split(":").length - 1;
	if (rest.startsWith("[")) {
		const end = rest.indexOf("]");
		if (end === -1) throw new Error(`Invalid host: ${spec} (missing "]")`);
		const hostPart = rest.slice(1, end);
		const tail = rest.slice(end + 1);
		if (tail.startsWith(":")) port = parsePort(tail.slice(1));
		rest = hostPart;
	} else if (colons === 1) {
		const [h, p] = rest.split(":");
		rest = h ?? "";
		port = parsePort(p ?? "");
	}

	if (!rest) throw new Error(`Invalid host: ${spec}`);
	// The target is a positional argv entry; a leading "-" would make ssh/scp
	// read it as an option (e.g. -oProxyCommand=...), which runs a local command.
	if (rest.startsWith("-") || user?.startsWith("-")) {
		throw new Error(`Invalid host: ${spec} (host and user must not start with "-")`);
	}
	return { user, host: rest, ...(port !== undefined ? { port } : {}) };
}

function parsePort(value: string): number {
	const n = Number.parseInt(value, 10);
	if (!Number.isInteger(n) || n < 1 || n > 65535) {
		throw new Error(`Invalid port: ${value}`);
	}
	return n;
}

/** Parse effective destination fields emitted by OpenSSH's `ssh -G`. */
export function parseSshConfig(output: string): HostSpec | undefined {
	const values = new Map(
		output
			.split("\n")
			.map((line) => line.trim().split(/\s+/, 2))
			.filter((parts): parts is [string, string] => parts.length === 2),
	);
	const user = values.get("user");
	const host = values.get("hostname");
	const port = values.get("port");
	if (!user || !host || !port) return undefined;
	return { user, host, port: parsePort(port) };
}

/** Resolve aliases through OpenSSH config, including Include and Match rules. */
export async function resolveSshHost(spec: HostSpec, signal?: AbortSignal): Promise<HostSpec> {
	const args = ["-G"];
	if (spec.port !== undefined) args.push("-p", String(spec.port));
	args.push(hostTarget(spec));

	try {
		const result = await runTool("ssh", args, { signal });
		return result.code === 0 ? (parseSshConfig(result.stdout) ?? spec) : spec;
	} catch {
		signal?.throwIfAborted();
		return spec;
	}
}

// ── Host inventory (info action) ─────────────────────────────────────────────

export interface HostAlias {
	alias: string;
	hostname?: string;
	user?: string;
	port?: string;
	proxyJump?: string;
	identityFile?: string;
}

export interface HostInfo {
	hostname?: string;
	user?: string;
	port?: string;
	proxyJump?: string;
	identityFile?: string;
}

/** Fields we surface from an ssh config Host block or `ssh -G` output. */
const INFO_KEYS: Record<string, keyof HostInfo> = {
	hostname: "hostname",
	user: "user",
	port: "port",
	proxyjump: "proxyJump",
	identityfile: "identityFile",
};

/**
 * Parse `Host` blocks out of an ssh_config text. Returns one entry per alias
 * token (a single `Host a b` line yields two aliases). Wildcard-only patterns
 * (`*`, `?`, `!`) are skipped since they aren't connectable targets. Keys are
 * matched case-insensitively; the first value for a key within a block wins
 * (OpenSSH "first obtained value" semantics).
 */
export function parseHostAliases(text: string): HostAlias[] {
	const out: HostAlias[] = [];
	let current: HostAlias[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.replace(/#.*$/, "").trim();
		if (!line) continue;
		const [keyRaw, ...rest] = line.split(/\s+/);
		const key = (keyRaw ?? "").toLowerCase();
		const value = rest.join(" ");
		if (key === "host") {
			current = rest.filter((p) => !/[*?!]/.test(p)).map((alias) => ({ alias }));
			out.push(...current);
		} else if (current.length > 0) {
			const field = INFO_KEYS[key];
			if (field && value) {
				for (const entry of current) {
					if (entry[field] === undefined) entry[field] = value;
				}
			}
		}
	}
	return out;
}

/** Expand a Path with a leading `~` and resolve relative Includes against
 * the containing config's directory (OpenSSH semantics). */
function expandConfigPath(pattern: string, baseDir: string): string {
	const p = expandHome(pattern);
	return isAbsolute(p) ? p : resolvePath(baseDir, p);
}

/**
 * Read an ssh_config file and every file it pulls in via `Include`, returning
 * the concatenated Host aliases. Missing files and glob misses are ignored
 * (OpenSSH tolerates them). `seen` guards against Include cycles.
 */
export function readSshConfigAliases(
	path = join(homeDir(), ".ssh", "config"),
	seen = new Set<string>(),
): HostAlias[] {
	if (seen.has(path)) return [];
	seen.add(path);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	const baseDir = join(homeDir(), ".ssh");
	const out: HostAlias[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.replace(/#.*$/, "").trim();
		const [keyRaw, ...rest] = line.split(/\s+/);
		if ((keyRaw ?? "").toLowerCase() === "include") {
			for (const pattern of rest) {
				const expanded = expandConfigPath(pattern, baseDir);
				let matches: string[] = [];
				try {
					matches = globSync(expanded);
				} catch {
					matches = [];
				}
				for (const file of matches.sort()) out.push(...readSshConfigAliases(file, seen));
			}
		}
	}
	out.push(...parseHostAliases(text));
	return out;
}

/** Full effective config for one host via `ssh -G` (no connection made). */
export function parseHostInfo(output: string): HostInfo {
	const info: HostInfo = {};
	for (const line of output.split("\n")) {
		const [keyRaw, ...rest] = line.trim().split(/\s+/);
		const field = INFO_KEYS[(keyRaw ?? "").toLowerCase()];
		const value = rest.join(" ");
		if (field && value && info[field] === undefined) info[field] = value;
	}
	return info;
}

/** Run `ssh -G <host>` and return its effective config. Never connects. */
export async function resolveHostInfo(spec: HostSpec, signal?: AbortSignal): Promise<HostInfo> {
	const args = ["-G"];
	if (spec.port !== undefined) args.push("-p", String(spec.port));
	args.push(hostTarget(spec));
	try {
		const result = await runTool("ssh", args, { signal });
		return result.code === 0 ? parseHostInfo(result.stdout) : {};
	} catch {
		signal?.throwIfAborted();
		return {};
	}
}

/** Canonical `[user@]host` target string for ssh argv. */
export function hostTarget(spec: HostSpec): string {
	return spec.user ? `${spec.user}@${spec.host}` : spec.host;
}

/** Stable per-host ControlMaster socket path (survives across calls in a
 * session so multiplexing can reuse the connection). */
export function controlPathFor(spec: HostSpec): string {
	const key = `${spec.user ?? ""}@${spec.host}:${spec.port ?? 22}`;
	const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
	return join(tempDir(), `pix-ssh-${hash}.sock`);
}

// ── ssh argv construction ────────────────────────────────────────────────────

/** Base ssh options shared by every invocation: multiplexing + timeouts +
 * non-interactive prompts (BatchMode is toggled by the caller). */
function connectionArgs(spec: HostSpec, controlPath: string, portFlag: "-p" | "-P"): string[] {
	const args = [
		"-o",
		"ControlMaster=auto",
		"-o",
		`ControlPath=${controlPath}`,
		"-o",
		`ControlPersist=${CONTROL_PERSIST_SECONDS}`,
		"-o",
		`ConnectTimeout=${CONNECT_TIMEOUT_SECONDS}`,
		"-o",
		"StrictHostKeyChecking=accept-new",
	];
	if (spec.port !== undefined) args.push(portFlag, String(spec.port));
	return args;
}

export function baseSshArgs(spec: HostSpec, controlPath: string): string[] {
	return connectionArgs(spec, controlPath, "-p");
}

/** SCP shares SSH connection options but uses uppercase `-P` for its port. */
export function baseScpArgs(spec: HostSpec, controlPath: string, recursive: boolean): string[] {
	return [...connectionArgs(spec, controlPath, "-P"), ...(recursive ? ["-r"] : [])];
}

/** Format SCP's remote endpoint, bracketing IPv6 literals. */
export function remoteTransferPath(spec: HostSpec, path: string): string {
	const host = spec.host.includes(":") ? `[${spec.host}]` : spec.host;
	return `${spec.user ? `${spec.user}@` : ""}${host}:${path}`;
}

export function transferArgs(
	spec: HostSpec,
	direction: TransferDirection,
	source: string,
	destination: string,
): string[] {
	return direction === "upload"
		? [source, remoteTransferPath(spec, destination)]
		: [remoteTransferPath(spec, source), destination];
}

/** Wrap a command for optional remote sudo. `sudo -S -p ''` reads the sudo
 * password from stdin with no prompt echo; the command runs under `sh -c`. */
export function remoteCommand(command: string, sudo: boolean): string {
	if (!sudo) return command;
	return `sudo -S -p '' -- sh -c ${shellQuote(command)}`;
}

/** Single-quote a string for POSIX sh (wrap in quotes, escape embedded quotes). */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

// ── Auth-failure detection ───────────────────────────────────────────────────

/** SSH-level auth/connection failure (wrong login password, refused, etc.). */
export function detectSshFailure(code: number, stderr: string): boolean {
	if (code === 0) return false;
	const lower = stderr.toLowerCase();
	return (
		lower.includes("permission denied") ||
		lower.includes("connection refused") ||
		lower.includes("connection timed out") ||
		lower.includes("could not resolve hostname") ||
		lower.includes("no route to host") ||
		lower.includes("host key verification failed")
	);
}

/** Remote sudo password failure. */
export function detectSudoFailure(stderr: string): boolean {
	const lower = stderr.toLowerCase();
	return (
		lower.includes("incorrect password") ||
		lower.includes("sudo: a password is required") ||
		lower.includes("authentication failure") ||
		lower.includes("sorry, try again")
	);
}

/** Strip the remote sudo prompt lines from stderr (we pass `-p ''` but some
 * sudo builds still emit a newline or prompt fragment). */
export function filterSudoPrompt(raw: string): string {
	return raw
		.split("\n")
		.filter((l) => !/^\s*(\[sudo\] )?password( for .*)?:?\s*$/i.test(l))
		.join("\n");
}

export { truncateOutput as truncate } from "@xynogen/pix-runtime/utf8";

// ── Runners ──────────────────────────────────────────────────────────────────

/** A host identity failure must never be treated as a bad login password. */
export class HostKeyError extends Error {
	constructor(readonly stderr: string) {
		super(`SSH host key verification failed — this is not a password error.\n${stderr}`);
		this.name = "HostKeyError";
	}
}

export function detectHostKeyFailure(stderr: string): boolean {
	return /REMOTE HOST IDENTIFICATION HAS CHANGED|host key verification failed|host key for .* has changed|REVOKED HOST KEY DETECTED/i.test(
		stderr,
	);
}

/** OpenSSH supplies this exact cleanup command; never evaluate it as shell text. */
export function hostKeyReset(stderr: string) {
	if (!/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr) || /REVOKED HOST KEY/i.test(stderr))
		return undefined;
	const command = stderr.match(/^\s*ssh-keygen -f (["'])([^\r\n]+?)\1 -R (["'])([^\r\n]+?)\3\s*$/m);
	const fingerprint = stderr.match(/SHA256:[A-Za-z0-9+/]{43}(?![A-Za-z0-9+/=])/)?.[0];
	if (!command || !fingerprint || !isAbsolute(command[2]!) || command[4]!.startsWith("-")) {
		return undefined;
	}
	return { file: command[2]!, host: command[4]!, fingerprint };
}

/** Capture without login credentials, pin the approved key, then replace only that host. */
export async function resetKnownHost(
	spec: HostSpec,
	reset: NonNullable<ReturnType<typeof hostKeyReset>>,
	signal?: AbortSignal,
): Promise<void> {
	const dir = mkdtempSync(join(tempDir(), "pix-ssh-host-key-"));
	try {
		const captured = join(dir, "captured");
		const options = [
			`UserKnownHostsFile=${captured}`,
			"GlobalKnownHostsFile=none",
			"KnownHostsCommand=none",
			"StrictHostKeyChecking=accept-new",
			"VerifyHostKeyDNS=no",
			"UpdateHostKeys=no",
			"BatchMode=yes",
			"ControlMaster=no",
			"ControlPath=none",
			`ConnectTimeout=${CONNECT_TIMEOUT_SECONDS}`,
			"FingerprintHash=sha256",
			"PreferredAuthentications=none",
			"PubkeyAuthentication=no",
			"PasswordAuthentication=no",
			"KbdInteractiveAuthentication=no",
			"GSSAPIAuthentication=no",
			"HostbasedAuthentication=no",
		];
		if (spec.port !== undefined) options.push(`Port=${spec.port}`);
		// An auth rejection is expected: only the unauthenticated host key is needed.
		await runTool("ssh", [...options.flatMap((o) => ["-o", o]), hostTarget(spec), "true"], {
			signal,
		});
		const keys = await runTool("ssh-keygen", ["-l", "-E", "sha256", "-f", captured], { signal });
		const fingerprints = keys.stdout
			.trim()
			.split("\n")
			.map((line) => line.split(/\s+/)[1]);
		if (keys.code !== 0 || fingerprints.length !== 1 || fingerprints[0] !== reset.fingerprint) {
			throw new Error(
				"Host key changed again or could not be verified. known_hosts was not changed.",
			);
		}
		const found = await runTool("ssh-keygen", ["-F", reset.host, "-f", captured], { signal });
		if (found.code !== 0)
			throw new Error(
				"Captured host does not match the reset target. known_hosts was not changed.",
			);
		const original = readFileSync(reset.file, "utf8");
		const mode = statSync(reset.file).mode & 0o777;
		const snapshot = join(dir, "known_hosts");
		writeFileAtomicSync(snapshot, original);
		const removed = await runTool("ssh-keygen", ["-R", reset.host, "-f", snapshot], { signal });
		if (removed.code !== 0) throw new Error(`Could not reset host key: ${removed.stderr}`);
		const cleaned = readFileSync(snapshot, "utf8");
		if (cleaned === original)
			throw new Error("No matching old host key found. known_hosts was not changed.");
		signal?.throwIfAborted();
		if (readFileSync(reset.file, "utf8") !== original) {
			throw new Error("known_hosts changed during confirmation. Retry; no keys were replaced.");
		}
		writeFileAtomicSync(`${reset.file}.old`, original, mode);
		writeFileAtomicSync(
			reset.file,
			`${cleaned.trimEnd()}\n${readFileSync(captured, "utf8")}`,
			mode,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Outcome of the key-auth probe. `ok` = connected without a password;
 * `auth` = reachable but needs a password; `unreachable` = host down / timeout
 * / DNS — a password won't help, so don't prompt. */
export type ProbeResult = "ok" | "auth" | "unreachable";

/**
 * Probe key-based (or agent, or existing-master) auth with `BatchMode=yes` so
 * ssh never prompts. Distinguishes three cases from the exit code + stderr:
 * clean connect (ok), auth rejected but host reachable (auth), and
 * connection/DNS failure (unreachable) — the last must NOT trigger a password
 * prompt, since a login password can't fix an unreachable host.
 * Pass `controlPath = "none"` to bypass a live master: a password-authed master
 * answers `ok` for any probe, which hides whether the key itself works.
 */
export async function probeKeyAuth(
	spec: HostSpec,
	controlPath: string,
	signal?: AbortSignal,
): Promise<ProbeResult> {
	const args = [...baseSshArgs(spec, controlPath), "-o", "BatchMode=yes", hostTarget(spec), "true"];
	try {
		const result = await runTool("ssh", args, { signal });
		if (result.code !== 0 && detectHostKeyFailure(result.stderr))
			throw new HostKeyError(result.stderr);
		return result.code === 0 ? "ok" : isUnreachable(result.stderr) ? "unreachable" : "auth";
	} catch (error) {
		signal?.throwIfAborted();
		if (error instanceof HostKeyError) throw error;
		return "unreachable";
	}
}

/** argv that asks the live master on `controlPath` to stop accepting new
 * sessions. `stop` (not `exit`) lets in-flight sessions finish. */
export function closeMasterArgs(spec: HostSpec, controlPath: string): string[] {
	return ["-o", `ControlPath=${controlPath}`, "-O", "stop", hostTarget(spec)];
}

/** Stop the multiplexed master so the next call opens (and authenticates) a
 * fresh connection. No master = no-op; errors are ignored for the same reason. */
export async function closeMaster(
	spec: HostSpec,
	controlPath: string,
	signal?: AbortSignal,
): Promise<void> {
	try {
		await runTool("ssh", closeMasterArgs(spec, controlPath), { signal });
	} catch {
		signal?.throwIfAborted();
	}
}

/**
 * Validate an SSH *login* password by attempting one real password auth. Forces
 * password auth (no pubkey/agent) with a single prompt, fed via `sshpass -e`
 * (env, never argv). Returns true only on a clean login; an auth rejection
 * returns false so the overlay can re-prompt. Unreachable/spawn errors return
 * true — a password can't fix connectivity, so defer to the real run instead of
 * burning retry attempts. ponytail: each call is one fresh connection (its own
 * MaxAuthTries counter, NumberOfPasswordPrompts=1), so retries don't stack
 * toward a per-connection lockout; a host with fail2ban-style IP banning is the
 * ceiling — then drop back to a single prompt.
 */
export async function probePasswordAuth(
	spec: HostSpec,
	controlPath: string,
	password: string,
	signal?: AbortSignal,
): Promise<boolean> {
	const args = [
		"-e",
		"ssh",
		...baseSshArgs(spec, controlPath),
		"-o",
		"BatchMode=no",
		"-o",
		"PubkeyAuthentication=no",
		"-o",
		"PreferredAuthentications=password",
		"-o",
		"NumberOfPasswordPrompts=1",
		hostTarget(spec),
		"true",
	];
	try {
		const result = await runTool("sshpass", args, {
			signal,
			env: { ...process.env, SSHPASS: password },
		});
		// Defer a key change during password entry to the real run, not a wrong-password retry.
		return result.code === 0 || detectHostKeyFailure(result.stderr) || isUnreachable(result.stderr);
	} catch {
		signal?.throwIfAborted();
		return true;
	}
}

/**
 * Probe whether remote sudo runs without a password (NOPASSWD sudoers) via
 * `sudo -n true`. Returns true when no sudo password is needed. Requires a
 * passwordless SSH connection (key/agent/existing-master or a cached login
 * password) — the probe opens its own channel with `BatchMode=yes`, so callers
 * must only probe when SSH login auth already succeeds without prompting.
 */
export async function probeSudoNoPassword(
	spec: HostSpec,
	controlPath: string,
	signal?: AbortSignal,
): Promise<boolean> {
	const args = [
		...baseSshArgs(spec, controlPath),
		"-o",
		"BatchMode=yes",
		hostTarget(spec),
		"sudo -n true",
	];
	try {
		return (await runTool("ssh", args, { signal })).code === 0;
	} catch {
		signal?.throwIfAborted();
		return false;
	}
}

/** Connection/DNS-level failure (not an auth rejection) — a password can't fix it. */
export function isUnreachable(stderr: string): boolean {
	const lower = stderr.toLowerCase();
	return (
		lower.includes("connection timed out") ||
		lower.includes("connection refused") ||
		lower.includes("could not resolve hostname") ||
		lower.includes("no route to host") ||
		lower.includes("network is unreachable") ||
		lower.includes("operation timed out")
	);
}

export interface RunOptions {
	/** SSH login password (only used when key auth failed). Fed via SSHPASS env. */
	loginPassword?: string;
	/** Run the remote command under sudo -S. */
	sudo?: boolean;
	/** Remote sudo password, piped to sudo's stdin. */
	sudoPassword?: string;
	controlPath: string;
	signal?: AbortSignal;
}

/** Probe the SFTP subsystem without running a remote shell. */
export async function probeSftp(
	spec: HostSpec,
	controlPath: string,
	signal?: AbortSignal,
	loginPassword?: string,
): Promise<ProbeResult> {
	try {
		const result = await runSftp(
			{
				host: hostTarget(spec),
				args: baseScpArgs(spec, controlPath, false),
				signal,
				loginPassword,
			},
			["pwd"],
		);
		if (result.code !== 0 && detectHostKeyFailure(result.stderr))
			throw new HostKeyError(result.stderr);
		return result.code === 0
			? "ok"
			: isUnreachable(result.stderr)
				? "unreachable"
				: detectSshFailure(result.code ?? 1, result.stderr)
					? "auth"
					: "unreachable";
	} catch (error) {
		signal?.throwIfAborted();
		if (error instanceof HostKeyError) throw error;
		return "unreachable";
	}
}

export async function runFile(
	spec: HostSpec,
	action: "read" | "write" | "edit",
	input: { path: string; content?: string; offset?: number; limit?: number; edits?: unknown },
	opts: Pick<RunOptions, "controlPath" | "loginPassword" | "signal">,
): Promise<SshResult> {
	input = { ...input, path: sftpPath(input.path) };
	return withSftp(
		{
			host: hostTarget(spec),
			args: baseScpArgs(spec, "none", false),
			loginPassword: opts.loginPassword,
			signal: opts.signal,
		},
		async (files) => {
			const key = `ssh:${hostTarget(spec)}:${spec.port ?? 22}:${input.path}`;
			if (action === "read") {
				const data = readText(await files.readFile(input.path), input.offset, input.limit);
				return {
					code: 0,
					stderr: "",
					stdout: [data.modelContent, data.notice].filter(Boolean).join("\n\n"),
				};
			}
			if (action === "write") {
				await writeText(input.path, input.content!, files, opts.signal, key);
				return { code: 0, stderr: "", stdout: `Successfully wrote to ${input.path}` };
			}
			const applied = await editText(
				input.path,
				{ path: input.path, edits: input.edits } as EditInput,
				files,
				opts.signal,
				key,
			);
			return {
				code: 0,
				stderr: "",
				stdout: `Edited ${input.path}: ${applied.ops.length} operations.\nCurrent anchors:\n${applied.fresh}`,
			};
		},
	);
}

export function runTransfer(
	spec: HostSpec,
	direction: TransferDirection,
	source: string,
	destination: string,
	recursive: boolean,
	opts: Pick<RunOptions, "controlPath" | "loginPassword" | "signal">,
): Promise<SshResult> {
	const endpoint = ["--", ...transferArgs(spec, direction, source, destination)];
	const bin = opts.loginPassword ? "sshpass" : "scp";
	// Same rule as runSsh: without a password in hand, force BatchMode so scp
	// never opens its own /dev/tty prompt. sshpass path keeps prompts on.
	const args = opts.loginPassword
		? ["-e", "scp", ...baseScpArgs(spec, opts.controlPath, recursive), ...endpoint]
		: [...baseScpArgs(spec, opts.controlPath, recursive), "-o", "BatchMode=yes", ...endpoint];
	const env = opts.loginPassword ? { ...process.env, SSHPASS: opts.loginPassword } : process.env;
	return spawnResult(bin, args, env, opts.signal);
}

/**
 * Build the ssh/sshpass argv for a run.
 *
 * Without a login password, force `BatchMode=yes` so ssh NEVER falls back to a
 * `/dev/tty` password prompt (which leaks into the TUI). A run-time auth failure
 * then returns a clean error the caller surfaces — all interactive password
 * entry goes through the overlay + `sshpass`. With a password, BatchMode stays
 * off so sshpass can answer ssh's own prompt.
 */
export function buildRunSshArgs(
	spec: HostSpec,
	command: string,
	opts: Pick<RunOptions, "controlPath" | "loginPassword" | "sudo">,
): { bin: string; args: string[] } {
	const remote = remoteCommand(command, opts.sudo === true);
	const base = baseSshArgs(spec, opts.controlPath);
	if (opts.loginPassword) {
		return { bin: "sshpass", args: ["-e", "ssh", ...base, hostTarget(spec), remote] };
	}
	return { bin: "ssh", args: [...base, "-o", "BatchMode=yes", hostTarget(spec), remote] };
}

/** Run a remote shell command; sudo and login passwords never enter argv. */
export function runSsh(spec: HostSpec, command: string, opts: RunOptions): Promise<SshResult> {
	const { bin, args } = buildRunSshArgs(spec, command, opts);
	const env = opts.loginPassword ? { ...process.env, SSHPASS: opts.loginPassword } : process.env;

	// Remote sudo reads its password from stdin (first line); anything else
	// closes stdin so the remote command sees EOF.
	const stdin = opts.sudo && opts.sudoPassword !== undefined ? `${opts.sudoPassword}\n` : undefined;
	return spawnResult(bin, args, env, opts.signal, opts.sudo ? filterSudoPrompt : undefined, stdin);
}

async function spawnResult(
	bin: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	sig?: AbortSignal,
	filterStderr?: (value: string) => string,
	stdin?: string,
): Promise<SshResult> {
	const result = await runTool(bin, args, { env, signal: sig, input: stdin });
	return {
		stdout: result.stdout,
		stderr: filterStderr ? filterStderr(result.stderr) : result.stderr,
		code: result.code ?? 1,
	};
}
