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

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAX_OUTPUT_BYTES = 50 * 1024;
export const MAX_OUTPUT_LINES = 2000;

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
	return { user, host: rest, ...(port !== undefined ? { port } : {}) };
}

function parsePort(value: string): number {
	const n = Number.parseInt(value, 10);
	if (!Number.isInteger(n) || n < 1 || n > 65535) {
		throw new Error(`Invalid port: ${value}`);
	}
	return n;
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
	return join(tmpdir(), `pix-ssh-${hash}.sock`);
}

// ── ssh argv construction ────────────────────────────────────────────────────

/** Base ssh options shared by every invocation: multiplexing + timeouts +
 * non-interactive prompts (BatchMode is toggled by the caller). */
export function baseSshArgs(spec: HostSpec, controlPath: string): string[] {
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
	if (spec.port !== undefined) args.push("-p", String(spec.port));
	return args;
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

// ── Output truncation ────────────────────────────────────────────────────────

export function truncate(
	text: string,
	maxLines = MAX_OUTPUT_LINES,
	maxBytes = MAX_OUTPUT_BYTES,
): { text: string; truncated: boolean } {
	const lines = text.split("\n");
	const byteLen = Buffer.byteLength(text, "utf8");
	if (lines.length <= maxLines && byteLen <= maxBytes) {
		return { text, truncated: false };
	}
	const kept = lines.slice(0, maxLines);
	let result = kept.join("\n");
	if (Buffer.byteLength(result, "utf8") > maxBytes) {
		result = Buffer.from(result, "utf8").slice(0, maxBytes).toString("utf8");
	}
	return { text: result, truncated: true };
}

// ── Runners ──────────────────────────────────────────────────────────────────

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
 */
export function probeKeyAuth(
	spec: HostSpec,
	controlPath: string,
	signal?: AbortSignal,
): Promise<ProbeResult> {
	const args = [...baseSshArgs(spec, controlPath), "-o", "BatchMode=yes", hostTarget(spec), "true"];
	return new Promise((resolve) => {
		let stderr = "";
		const proc = spawn("ssh", args, { stdio: ["ignore", "ignore", "pipe"] });
		proc.stderr.on("data", (c: Buffer) => {
			stderr += c.toString();
		});
		proc.on("error", () => resolve("unreachable"));
		proc.on("close", (code) => {
			if (code === 0) return resolve("ok");
			if (isUnreachable(stderr)) return resolve("unreachable");
			resolve("auth");
		});
		signal?.addEventListener("abort", () => proc.kill("SIGTERM"), { once: true });
	});
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

/**
 * Run `command` on the remote host. When `loginPassword` is set, ssh is wrapped
 * in `sshpass -e` (password via env, not argv). When `sudo` is set, the command
 * is wrapped in `sudo -S` and `sudoPassword` is written to the remote stdin.
 */
export function runSsh(spec: HostSpec, command: string, opts: RunOptions): Promise<SshResult> {
	const remote = remoteCommand(command, opts.sudo === true);
	const sshArgs = [...baseSshArgs(spec, opts.controlPath), hostTarget(spec), remote];

	let bin = "ssh";
	let args = sshArgs;
	let env = process.env;
	if (opts.loginPassword) {
		bin = "sshpass";
		args = ["-e", "ssh", ...sshArgs];
		env = { ...process.env, SSHPASS: opts.loginPassword };
	}

	return new Promise((resolve, reject) => {
		const proc = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env });
		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (c: Buffer) => {
			stdout += c.toString();
		});
		proc.stderr.on("data", (c: Buffer) => {
			const filtered = opts.sudo ? filterSudoPrompt(c.toString()) : c.toString();
			if (filtered) stderr += filtered;
		});

		proc.on("error", reject);
		proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));

		// Remote sudo reads its password from stdin (first line); anything else
		// closes stdin so the remote command sees EOF.
		if (opts.sudo && opts.sudoPassword !== undefined) {
			proc.stdin.write(`${opts.sudoPassword}\n`);
		}
		proc.stdin.end();

		signal(opts.signal, proc, reject);
	});
}

function signal(
	sig: AbortSignal | undefined,
	proc: ReturnType<typeof spawn>,
	reject: (e: Error) => void,
): void {
	sig?.addEventListener(
		"abort",
		() => {
			proc.kill("SIGTERM");
			reject(new Error("Cancelled"));
		},
		{ once: true },
	);
}
