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
import { globSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";

export const MAX_OUTPUT_BYTES = 50 * 1024;
export const MAX_OUTPUT_LINES = 2000;

/** Per-host approval TTL (ms) — mirrors sudo's PAM ticket window (~15 min). */
export const APPROVAL_TTL_MS = 15 * 60_000;

/**
 * True when `key` has a live (non-expired) approval in `map`; deletes the entry
 * on expiry so the map self-prunes. `now` is injectable for tests.
 */
export function hostApproved(map: Map<string, number>, key: string, now = Date.now()): boolean {
	const expiry = map.get(key);
	if (expiry === undefined) return false;
	if (now >= expiry) {
		map.delete(key);
		return false;
	}
	return true;
}

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
export type UnattendedMode = "off" | "afk" | "yolo";

/** Warning-level transfer policy. Password prompts cannot run unattended. */
export function transferApprovalDecision(
	mode: UnattendedMode,
	loginPasswordMissing: boolean,
): "ask" | "allow" | "deny" {
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
export function resolveSshHost(spec: HostSpec, signal?: AbortSignal): Promise<HostSpec> {
	const args = ["-G"];
	if (spec.port !== undefined) args.push("-p", String(spec.port));
	args.push(hostTarget(spec));

	return new Promise((resolve) => {
		let stdout = "";
		const proc = spawn("ssh", args, { stdio: ["ignore", "pipe", "ignore"] });
		proc.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		proc.on("error", () => resolve(spec));
		proc.on("close", (code) => resolve(code === 0 ? (parseSshConfig(stdout) ?? spec) : spec));
		signal?.addEventListener("abort", () => proc.kill("SIGTERM"), { once: true });
	});
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
	let p = pattern;
	if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
	else if (p === "~") p = homedir();
	return isAbsolute(p) ? p : resolvePath(baseDir, p);
}

/**
 * Read an ssh_config file and every file it pulls in via `Include`, returning
 * the concatenated Host aliases. Missing files and glob misses are ignored
 * (OpenSSH tolerates them). `seen` guards against Include cycles.
 */
export function readSshConfigAliases(
	path = join(homedir(), ".ssh", "config"),
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
	const baseDir = join(homedir(), ".ssh");
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
export function resolveHostInfo(spec: HostSpec, signal?: AbortSignal): Promise<HostInfo> {
	const args = ["-G"];
	if (spec.port !== undefined) args.push("-p", String(spec.port));
	args.push(hostTarget(spec));
	return new Promise((resolve) => {
		let stdout = "";
		const proc = spawn("ssh", args, { stdio: ["ignore", "pipe", "ignore"] });
		proc.stdout.on("data", (c: Buffer) => {
			stdout += c.toString();
		});
		proc.on("error", () => resolve({}));
		proc.on("close", (code) => resolve(code === 0 ? parseHostInfo(stdout) : {}));
		signal?.addEventListener("abort", () => proc.kill("SIGTERM"), { once: true });
	});
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
		result = Buffer.from(result, "utf8").subarray(0, maxBytes).toString("utf8");
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
export function runTransfer(
	spec: HostSpec,
	direction: TransferDirection,
	source: string,
	destination: string,
	recursive: boolean,
	opts: Pick<RunOptions, "controlPath" | "loginPassword" | "signal">,
): Promise<SshResult> {
	const scpArgs = [
		...baseScpArgs(spec, opts.controlPath, recursive),
		"--",
		...transferArgs(spec, direction, source, destination),
	];
	const bin = opts.loginPassword ? "sshpass" : "scp";
	const args = opts.loginPassword ? ["-e", "scp", ...scpArgs] : scpArgs;
	const env = opts.loginPassword ? { ...process.env, SSHPASS: opts.loginPassword } : process.env;
	return spawnResult(bin, args, env, opts.signal);
}

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

	// Remote sudo reads its password from stdin (first line); anything else
	// closes stdin so the remote command sees EOF.
	const stdin = opts.sudo && opts.sudoPassword !== undefined ? `${opts.sudoPassword}\n` : undefined;
	return spawnResult(bin, args, env, opts.signal, opts.sudo ? filterSudoPrompt : undefined, stdin);
}

function spawnResult(
	bin: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	sig?: AbortSignal,
	filterStderr?: (value: string) => string,
	stdin?: string,
): Promise<SshResult> {
	return new Promise((resolve, reject) => {
		const proc = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env });
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (c: Buffer) => {
			stdout += c.toString();
		});
		proc.stderr.on("data", (c: Buffer) => {
			const value = filterStderr ? filterStderr(c.toString()) : c.toString();
			if (value) stderr += value;
		});
		proc.on("error", reject);
		proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
		if (stdin) proc.stdin.write(stdin);
		proc.stdin.end();
		signal(sig, proc, reject);
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
