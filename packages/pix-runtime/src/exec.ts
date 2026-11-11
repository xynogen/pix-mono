/**
 * exec.ts — run a catalogued binary by name, on any OS.
 *
 * Every pix package that starts an external program goes through here, so:
 *   - the binary comes from the one resolver (binary.json → `<agentDir>/bin` →
 *     known install dirs → PATH), never a bare-name OS lookup;
 *   - a missing binary is a {@link BinaryMissingError} with an install hint, and
 *     the async runners download it first when the catalog has a trusted release;
 *   - Windows `.cmd`/`.bat` shims (npm, npx, pi) run through `cmd.exe` with
 *     strict quoting, since Node refuses to spawn them without a shell.
 *
 * Callers pass the tool's arguments unchanged; this layer never adds a shell
 * for real executables.
 */

import {
	type ChildProcess,
	type ChildProcessWithoutNullStreams,
	type SpawnOptions,
	type SpawnOptionsWithStdioTuple,
	type SpawnSyncOptions,
	type StdioNull,
	type StdioPipe,
	spawn,
	spawnSync,
} from "node:child_process";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { onAbort } from "./abort.ts";
import { type EnsureOptions, ensureTool, type ToolStatus } from "./binaries/ensure.ts";
import { type LookupOptions, type ResolvedTool, requireTool } from "./binaries/resolve.ts";
import { currentPlatform, type HostPlatform } from "./platform.ts";

export type { ChildProcess } from "node:child_process";

// ── Windows shim quoting ────────────────────────────────────────────────────
// Ported from cross-spawn (MIT): arguments are quoted for the program's
// CommandLineToArgvW parsing, then cmd.exe metacharacters are caret-escaped.
// npm-style shims under node_modules/.bin re-parse their arguments, so they get
// a second round of caret escaping.

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
const CMD_SHIM_IN_BIN = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;

/** True when `path` is a batch file that needs `cmd.exe` to run. */
export function isBatchFile(path: string): boolean {
	return /\.(cmd|bat)$/i.test(path);
}

/** Quote one argument for a `cmd.exe /d /s /c "…"` line. */
export function quoteForCmd(arg: string, doubleEscape = false): string {
	let out = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
	out = `"${out}"`.replace(CMD_META, "^$1");
	return doubleEscape ? out.replace(CMD_META, "^$1") : out;
}

export interface CommandLine {
	command: string;
	args: string[];
	/** Must be passed to spawn so Node does not re-quote the cmd.exe line. */
	windowsVerbatimArguments?: boolean;
}

/**
 * Translate `path args…` into what spawn needs on this host. Real executables
 * pass through untouched; Windows batch files become one quoted `cmd.exe` line.
 */
export function commandLine(
	path: string,
	args: readonly string[],
	host: HostPlatform = currentPlatform(),
	env: NodeJS.ProcessEnv = process.env,
): CommandLine {
	if (host.os !== "win32" || !isBatchFile(path)) return { command: path, args: [...args] };
	const doubleEscape = CMD_SHIM_IN_BIN.test(path);
	const line = [
		path.replace(CMD_META, "^$1"),
		...args.map((a) => quoteForCmd(a, doubleEscape)),
	].join(" ");
	const root = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
	return {
		command: env.ComSpec ?? env.COMSPEC ?? join(root, "System32", "cmd.exe"),
		args: ["/d", "/s", "/c", `"${line}"`],
		windowsVerbatimArguments: true,
	};
}

// ── Runners ─────────────────────────────────────────────────────────────────

export interface ToolExecOptions {
	cwd?: string;
	/** Child environment; also where PATH is read for the lookup. Default process.env. */
	env?: NodeJS.ProcessEnv;
	/** Kill the child after this many ms (result has `timedOut: true`). */
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Written to stdin, then stdin is closed. */
	input?: string | Buffer;
	/** Download progress when the binary is fetched first (async runners only). */
	onStatus?: (status: ToolStatus) => void;
	/** Test seam for the host OS. */
	host?: HostPlatform;
	/** Cap on captured stdout/stderr bytes each (default 50 MB). Past it the child is stopped. */
	maxBuffer?: number;
	/** Args are already quoted for the target (cmd.exe `/c` lines); Node must not re-quote. */
	verbatim?: boolean;
}

export interface ToolRunResult {
	/** Exit code, or null when killed by a signal/timeout. */
	code: number | null;
	stdout: string;
	stderr: string;
	/** Raw stdout for binary output (clipboard images, archives). */
	stdoutBytes: Buffer;
	timedOut: boolean;
	/** Output passed `maxBuffer`; the child was stopped and output cut. Never a complete result. */
	truncated: boolean;
	/** The binary that ran and where it was found. */
	tool: ResolvedTool;
}

const MAX_BUFFER = 50 * 1024 * 1024;
/** Time between SIGTERM and SIGKILL, and then before open pipes are dropped. */
const KILL_GRACE_MS = 1500;

function lookupOpts(opts: ToolExecOptions): LookupOptions {
	return { env: opts.env, host: opts.host };
}

/**
 * Kill a child and its descendants. Windows: `taskkill /T /F` (a cmd.exe wrapper
 * leaves the shim running otherwise). POSIX: signal the child's process group
 * (runTool starts it as a group leader), because a descendant that keeps
 * stdout open would otherwise delay "close" past the timeout.
 */
function killTree(
	child: ChildProcess,
	host: HostPlatform,
	env: NodeJS.ProcessEnv,
	signal: NodeJS.Signals = "SIGTERM",
): void {
	if (!child.pid) return;
	if (host.os === "win32") {
		if (child.exitCode !== null || child.signalCode !== null) return;
		const root = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
		spawnSync(join(root, "System32", "taskkill.exe"), ["/pid", String(child.pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
		});
		return;
	}
	// The group can outlive the leader, so do not skip on child exit.
	try {
		process.kill(-child.pid, signal);
	} catch {
		// ESRCH: the group is gone. EPERM: not a group we own; fall back to the child.
		if (child.exitCode === null && child.signalCode === null) child.kill(signal);
	}
}

type HostOpt = { host?: HostPlatform };
type Pipe = StdioPipe;
type Null = StdioNull;
/** Child whose piped streams are typed non-null, mirroring Node's spawn overloads. */
type Piped<I, O, E> = ChildProcess & {
	stdin: I extends Pipe ? Writable : null;
	stdout: O extends Pipe ? Readable : null;
	stderr: E extends Pipe ? Readable : null;
};

/**
 * Start a resolved binary with Node's spawn options (stdio, detached, …).
 * Sync lookup, no download; throws {@link BinaryMissingError} when missing.
 */
export function spawnTool<I extends Pipe | Null, O extends Pipe | Null, E extends Pipe | Null>(
	name: string,
	args: readonly string[],
	options: SpawnOptionsWithStdioTuple<I, O, E> & HostOpt,
): Piped<I, O, E>;
export function spawnTool(
	name: string,
	args?: readonly string[],
	options?: Omit<SpawnOptions, "stdio"> & HostOpt,
): ChildProcessWithoutNullStreams;
export function spawnTool(
	name: string,
	args: readonly string[],
	options: SpawnOptions & HostOpt,
): ChildProcess;
export function spawnTool(
	name: string,
	args: readonly string[] = [],
	options: SpawnOptions & HostOpt = {},
): ChildProcess {
	const tool = requireTool(name, { env: options.env ?? process.env, host: options.host });
	return spawnPath(tool.path, args, options);
}

/**
 * Start an already-resolved executable with Node's spawn options. Windows batch
 * files run through `cmd.exe` with {@link commandLine} quoting; others pass through.
 * Lifetime (detached group, stdio, kill path) stays with the caller's options.
 */
export function spawnPath(
	path: string,
	args: readonly string[] = [],
	options: SpawnOptions & HostOpt = {},
): ChildProcess {
	const { host: hostOpt, ...spawnOpts } = options;
	const line = commandLine(path, args, hostOpt ?? currentPlatform(), spawnOpts.env ?? process.env);
	return spawn(line.command, line.args, {
		windowsHide: true,
		...spawnOpts,
		windowsVerbatimArguments: line.windowsVerbatimArguments ?? spawnOpts.windowsVerbatimArguments,
	});
}

/** Start a shell command line (`/bin/sh -c` on POSIX, `cmd.exe /d /s /c` on Windows). */
export function spawnShell(command: string, options: SpawnOptions = {}): ChildProcess {
	return spawn(command, { ...options, shell: true });
}

/** Run a resolved child to completion, collecting output. */
function collect(
	child: ChildProcess,
	tool: ResolvedTool,
	opts: ToolExecOptions,
	host: HostPlatform,
) {
	const env = opts.env ?? process.env;
	const cap = opts.maxBuffer ?? MAX_BUFFER;
	return new Promise<ToolRunResult>((resolve, reject) => {
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let outLen = 0;
		let errLen = 0;
		let timedOut = false;
		let truncated = false;
		const push = (list: Buffer[], chunk: Buffer, len: number): number => {
			const room = cap - len;
			// Like pi.exec: stop a runaway child instead of draining output nobody keeps.
			if (chunk.length > room) {
				truncated = true;
				stop();
			}
			if (room <= 0) return len;
			list.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
			return len + Math.min(chunk.length, room);
		};
		child.stdout?.on("data", (c: Buffer) => {
			outLen = push(out, c, outLen);
		});
		child.stderr?.on("data", (c: Buffer) => {
			errLen = push(err, c, errLen);
		});
		const escalation: NodeJS.Timeout[] = [];
		const stop = () => {
			if (escalation.length > 0) return;
			killTree(child, host, env);
			// A child may ignore SIGTERM. A descendant may leave the group and keep a
			// pipe open. Both would hold "close" forever, so escalate, then drop pipes.
			escalation.push(
				setTimeout(() => killTree(child, host, env, "SIGKILL"), KILL_GRACE_MS),
				setTimeout(() => {
					child.stdout?.destroy();
					child.stderr?.destroy();
				}, KILL_GRACE_MS * 2),
			);
		};
		const timer =
			opts.timeoutMs && opts.timeoutMs > 0
				? setTimeout(() => {
						timedOut = true;
						stop();
					}, opts.timeoutMs)
				: undefined;
		const detachAbort = onAbort(opts.signal, stop);
		const done = () => {
			if (timer) clearTimeout(timer);
			for (const t of escalation) clearTimeout(t);
			detachAbort();
		};
		child.on("error", (e) => {
			done();
			reject(e);
		});
		child.on("close", (code) => {
			done();
			const stdoutBytes = Buffer.concat(out);
			resolve({
				code: timedOut ? null : code,
				stdout: stdoutBytes.toString("utf-8"),
				stderr: Buffer.concat(err).toString("utf-8"),
				stdoutBytes,
				timedOut,
				truncated,
				tool,
			});
		});
		// A child may exit without reading stdin (EPIPE). With no listener that is an
		// uncaught stream error that kills the host. The exit code still reports the
		// outcome. Other stdin errors come back through child "error" or "close".
		child.stdin?.on("error", () => {});
		if (opts.input !== undefined) child.stdin?.end(opts.input);
		else child.stdin?.end();
	});
}

/**
 * Run `name args…` and capture its output. Downloads the binary first when it
 * is missing and the catalog has a release for this host (progress via
 * `onStatus`). Rejects with {@link BinaryMissingError} when it cannot be found.
 * A non-zero exit resolves normally — check `code`.
 */
export async function runTool(
	name: string,
	args: readonly string[],
	opts: ToolExecOptions = {},
): Promise<ToolRunResult> {
	opts.signal?.throwIfAborted();
	const host = opts.host ?? currentPlatform();
	const ensure: EnsureOptions = {
		env: opts.env,
		host,
		onStatus: opts.onStatus,
		signal: opts.signal,
	};
	const tool = await ensureTool(name, ensure);
	if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("aborted");
	const env = opts.env ?? process.env;
	const line = opts.verbatim
		? { command: tool.path, args: [...args], windowsVerbatimArguments: true }
		: commandLine(tool.path, args, host, env);
	const child = spawn(line.command, line.args, {
		cwd: opts.cwd,
		env,
		stdio: ["pipe", "pipe", "pipe"],
		// POSIX: own process group, so killTree reaches descendants. On Windows
		// `detached` opens a new console, and taskkill /T covers the tree.
		// ponytail: the group also has no controlling terminal, so a tool cannot
		// prompt on /dev/tty. runTool is for captured, non-interactive runs.
		// Interactive tools use spawnTool.
		detached: host.os !== "win32",
		windowsHide: true,
		windowsVerbatimArguments: line.windowsVerbatimArguments,
	});
	const result = await collect(child, tool, opts, host);
	opts.signal?.throwIfAborted();
	return result;
}

/**
 * Blocking {@link runTool} for startup probes and sync call sites. Never
 * downloads; throws {@link BinaryMissingError} when missing.
 */
export function runToolSync(
	name: string,
	args: readonly string[],
	opts: Omit<ToolExecOptions, "signal" | "onStatus"> = {},
): ToolRunResult {
	const host = opts.host ?? currentPlatform();
	const env = opts.env ?? process.env;
	const tool = requireTool(name, lookupOpts({ ...opts, host }));
	const line = commandLine(tool.path, args, host, env);
	const sync: SpawnSyncOptions = {
		cwd: opts.cwd,
		env,
		input: opts.input,
		timeout: opts.timeoutMs,
		maxBuffer: opts.maxBuffer ?? MAX_BUFFER,
		windowsHide: true,
		windowsVerbatimArguments: line.windowsVerbatimArguments,
	};
	const r = spawnSync(line.command, line.args, sync);
	// Over maxBuffer, spawnSync kills the child and sets ENOBUFS. That throws below,
	// so a sync result is never truncated.
	if (r.error && (r.error as NodeJS.ErrnoException).code !== "ETIMEDOUT") throw r.error;
	const stdoutBytes = Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(r.stdout ?? "");
	const stderr = Buffer.isBuffer(r.stderr) ? r.stderr.toString("utf-8") : String(r.stderr ?? "");
	const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
	return {
		code: timedOut ? null : r.status,
		stdout: stdoutBytes.toString("utf-8"),
		stderr,
		stdoutBytes,
		timedOut,
		truncated: false,
		tool,
	};
}
