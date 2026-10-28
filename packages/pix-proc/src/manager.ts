/**
 * ProcManager — owns spawned long-lived processes for one Pi session.
 *
 * Spawn shape (settled by design review):
 *   detached: true       → child leads its own process group (pgid === pid),
 *                          so we kill the whole tree via process.kill(-pgid).
 *   stdio: pipes          → the parent writes only the first MAX_LOG_BYTES to disk.
 *   child.unref()        → the child does not keep Pi alive.
 *
 * ponytail: stdout and stderr share one capped file. Their relative order depends
 * on pipe delivery. A process kept after a Pi crash loses its output pipes; a
 * separate recorder process would preserve capture across crashes.
 *
 * Crash reaper: each running process writes a pidfile {pgid, startTicks}. On the
 * next session_start we find pidfiles whose pgid is still alive AND whose start
 * ticks match (PID-reuse guard), then ask the user before killing.
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { open, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { generateLfid } from "@xynogen/pix-runtime/lfid";
import { cacheDir } from "@xynogen/pix-runtime/paths";
import { type LogView, logSince, MAX_LOG_LINES, type ProcMeta, tailLines } from "./format.ts";

export const PROC_DIR = join(cacheDir(), "proc");
export const MAX_LOG_BYTES = 50 * 1024 * 1024; // 50 MiB

/** Best-effort cleanup: a failed fd close / file unlink / signal is not fatal here. */
function silent(fn: () => void): void {
	try {
		fn();
	} catch {
		// intentional: cleanup and signal calls race process exit; failure is expected and harmless
	}
}

interface LiveProc {
	meta: ProcMeta;
	child?: ChildProcess;
	logPath: string;
	fd?: number;
	bytes: number;
	cursor: number; // model's byte cursor into the log
}

/** Read /proc/<pid>/stat field 22 (start time in clock ticks). Linux only. */
function readStartTicks(pid: number): string | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		// field 2 (comm) may contain spaces/parens; split after the last ')'.
		const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		return rest[19]; // field 22 overall = index 19 after the comm split
	} catch {
		return undefined;
	}
}

/**
 * A group id we may signal. `kill(-1)` hits every process the user owns and
 * `kill(-0)` our own group, so anything <= 1 (or a corrupt pidfile value) is
 * refused before it reaches process.kill.
 */
function safeGroupId(pgid: unknown): pgid is number {
	return Number.isSafeInteger(pgid) && (pgid as number) > 1;
}

function killGroup(pgid: number, signal: NodeJS.Signals): void {
	if (safeGroupId(pgid)) silent(() => process.kill(-pgid, signal));
}

/** Is a process group still alive? signal 0 tests existence without killing. */
function pgidAlive(pgid: number): boolean {
	if (!safeGroupId(pgid)) return false;
	try {
		process.kill(-pgid, 0);
		return true;
	} catch {
		return false;
	}
}

export interface Orphan {
	handle: string;
	pgid: number;
	command: string;
	name?: string;
	cwd?: string;
	startTime?: number;
}

export class ProcManager {
	private readonly procs = new Map<string, LiveProc>();

	constructor(private readonly logMaxBytes = MAX_LOG_BYTES) {
		if (!Number.isSafeInteger(logMaxBytes) || logMaxBytes < 1)
			throw new Error("logMaxBytes must be a positive safe integer");
		mkdirSync(PROC_DIR, { recursive: true });
	}

	/** Unique handle across the cache dir — a crashed session's handle is never reissued. */
	private freshHandle(): string {
		for (let i = 0; i < 64; i++) {
			const h = generateLfid({ prefix: "proc" });
			if (!this.procs.has(h) && !existsSync(join(PROC_DIR, `${h}.log`))) return h;
		}
		throw new Error("runner: handle namespace exhausted");
	}

	private pidPath(handle: string): string {
		return join(PROC_DIR, `${handle}.pid`);
	}
	private logPathFor(handle: string): string {
		return join(PROC_DIR, `${handle}.log`);
	}

	list(): ProcMeta[] {
		return [...this.procs.values()].map((p) => p.meta);
	}

	get(handle: string): LiveProc | undefined {
		return this.procs.get(handle);
	}

	/** Adopt a process kept from an earlier session so tools and widgets can manage it. */
	adoptOrphan(orphan: Orphan): ProcMeta {
		const existing = this.procs.get(orphan.handle);
		if (existing) return existing.meta;
		const meta: ProcMeta = {
			handle: orphan.handle,
			command: orphan.command,
			cwd: orphan.cwd ?? process.cwd(),
			name: orphan.name,
			pid: orphan.pgid,
			pgid: orphan.pgid,
			startTime: orphan.startTime ?? Date.now(),
			startTicks: readStartTicks(orphan.pgid),
			status: "running",
			capped: false,
		};
		this.procs.set(orphan.handle, {
			meta,
			logPath: this.logPathFor(orphan.handle),
			bytes: 0,
			cursor: 0,
		});
		return meta;
	}

	/** Spawn a detached process; the child writes stdout+stderr to its log file. */
	start(command: string, cwd: string, name?: string): ProcMeta {
		const handle = this.freshHandle();
		const logPath = this.logPathFor(handle);
		const fd = openSync(logPath, "w");
		let child: ChildProcess;
		try {
			child = spawn(command, {
				cwd,
				shell: true,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (err) {
			closeSync(fd);
			rmSync(logPath, { force: true });
			throw err;
		}
		// Spawn failures (bad cwd, missing shell) arrive as an async 'error' event;
		// without a listener Node rethrows it and takes Pi down.
		child.on("error", (err) => {
			const live = this.procs.get(handle);
			if (!live) return; // failed before registration; start() already threw
			live.meta.status = "exited";
			live.meta.logError ??= err.message;
			this.closeFd(live);
			silent(() => rmSync(this.pidPath(handle), { force: true }));
		});
		const pid = child.pid;
		if (!safeGroupId(pid)) {
			closeSync(fd);
			rmSync(logPath, { force: true });
			throw new Error(
				existsSync(cwd) ? `failed to start: ${command}` : `cwd does not exist: ${cwd}`,
			);
		}
		child.unref();
		const meta: ProcMeta = {
			handle,
			command,
			cwd,
			name,
			pid,
			pgid: pid, // detached leader → pgid === pid
			startTime: Date.now(),
			startTicks: readStartTicks(pid),
			status: "running",
			capped: false,
		};
		const live: LiveProc = { meta, child, logPath, fd, bytes: 0, cursor: 0 };
		for (const stream of [child.stdout, child.stderr]) {
			stream?.on("data", (chunk: Buffer) => {
				const length = Math.min(chunk.length, this.logMaxBytes - live.bytes);
				let offset = 0;
				try {
					while (offset < length && live.fd !== undefined) {
						const written = writeSync(live.fd, chunk, offset, length - offset);
						if (!written) throw new Error("process log write made no progress");
						offset += written;
						live.bytes += written;
					}
				} catch (err) {
					// A throw here would be uncaught (stream listener). Stop recording
					// (disk full, fd closed) and say why; the process keeps running.
					meta.capped = true;
					meta.logError = err instanceof Error ? err.message : String(err);
					this.closeFd(live);
					return;
				}
				if (live.bytes >= this.logMaxBytes) meta.capped = true;
			});
			if (stream && "unref" in stream && typeof stream.unref === "function") stream.unref();
		}
		this.procs.set(handle, live);
		writeFileSync(
			this.pidPath(handle),
			JSON.stringify({
				pgid: meta.pgid,
				startTicks: meta.startTicks,
				command,
				name,
				cwd,
				startTime: meta.startTime,
			}),
		);
		child.on("close", (code, signal) => {
			meta.status = signal ? "killed" : "exited";
			meta.exitCode = code ?? undefined;
			this.closeFd(live);
			silent(() => rmSync(this.pidPath(handle), { force: true }));
		});
		return meta;
	}

	private closeFd(live: LiveProc): void {
		if (live.fd !== undefined) {
			silent(() => closeSync(live.fd as number));
			live.fd = undefined;
		}
	}

	/** Update the status of an adopted process whose original parent is gone. */
	checkCap(handle: string): void {
		const live = this.procs.get(handle);
		if (live?.meta.status !== "running") return;
		if (!live.child && !pgidAlive(live.meta.pgid)) {
			live.meta.status = "exited";
			silent(() => rmSync(this.pidPath(handle), { force: true }));
			return;
		}
		if (!live.child) {
			try {
				live.meta.capped = statSync(live.logPath).size >= this.logMaxBytes;
			} catch {
				// An adopted process can lack its old log.
			}
		}
	}

	/** Cursor read — new complete lines since the model's last call. */
	async logsSince(
		handle: string,
	): Promise<(LogView & { logPath: string; capped: boolean; logError?: string }) | undefined> {
		const live = this.procs.get(handle);
		if (!live) return undefined;
		const text = await this.readLog(live.logPath);
		const view = logSince(text, live.cursor);
		live.cursor = view.offset;
		return {
			...view,
			logPath: live.logPath,
			capped: live.meta.capped,
			logError: live.meta.logError,
		};
	}

	/** Forced tail read — last n lines, does NOT move the model cursor. */
	async logsTail(
		handle: string,
		n: number,
	): Promise<{ lines: string[]; logPath: string; capped: boolean; logError?: string } | undefined> {
		const live = this.procs.get(handle);
		if (!live) return undefined;
		const lines = await this.readTail(live.logPath, n);
		return { lines, logPath: live.logPath, capped: live.meta.capped, logError: live.meta.logError };
	}

	/** Freshest complete line, for the widget/list. Does not move any cursor. */
	async lastLine(handle: string): Promise<string | undefined> {
		const live = this.procs.get(handle);
		if (!live) return undefined;
		return (await this.readTail(live.logPath, 1)).at(-1);
	}

	private async readTail(path: string, n: number): Promise<string[]> {
		let file: Awaited<ReturnType<typeof open>> | undefined;
		try {
			file = await open(path, "r");
			let offset = (await file.stat()).size;
			const chunks: Buffer[] = [];
			let newlines = 0;
			const count = Math.min(Math.max(1, Math.floor(n)), MAX_LOG_LINES);
			while (offset > 0 && newlines <= count) {
				const size = Math.min(offset, 8192);
				offset -= size;
				const chunk = Buffer.allocUnsafe(size);
				const { bytesRead } = await file.read(chunk, 0, size, offset);
				if (!bytesRead) break;
				const data = chunk.subarray(0, bytesRead);
				chunks.unshift(data);
				for (const byte of data) if (byte === 10) newlines++;
			}
			const lines = Buffer.concat(chunks).toString("utf8").split("\n");
			if (lines.at(-1) === "") lines.pop();
			return tailLines(lines, count);
		} catch {
			return [];
		} finally {
			await file?.close();
		}
	}

	private async readLog(path: string): Promise<string> {
		try {
			return await readFile(path, "utf8");
		} catch {
			return "";
		}
	}

	/** SIGTERM the whole group, then SIGKILL after grace. */
	async stop(handle: string, graceMs = 2000): Promise<{ ok: boolean; note: string }> {
		const live = this.procs.get(handle);
		if (!live) return { ok: false, note: `unknown handle ${handle}` };
		if (live.meta.status !== "running") {
			return {
				ok: true,
				note: `already ${live.meta.status === "killed" ? "killed" : `exited(${live.meta.exitCode ?? "?"})`}`,
			};
		}
		killGroup(live.meta.pgid, "SIGTERM");
		await new Promise((r) => setTimeout(r, graceMs));
		if (live.meta.status === "running") {
			killGroup(live.meta.pgid, "SIGKILL");
		}
		return { ok: true, note: `${handle} stopped` };
	}

	/** Remove a stopped process + its files. Refuses while running. */
	rm(handle: string): { ok: boolean; note: string } {
		const live = this.procs.get(handle);
		if (!live) return { ok: false, note: `unknown handle ${handle}` };
		if (live.meta.status === "running")
			return { ok: false, note: `${handle} still running — stop it first` };
		this.closeFd(live);
		silent(() => rmSync(live.logPath, { force: true }));
		silent(() => rmSync(this.pidPath(handle), { force: true }));
		this.procs.delete(handle);
		return { ok: true, note: `${handle} removed` };
	}

	/** Find orphaned process groups from a dead session (pgid alive + start ticks match). */
	async findOrphans(): Promise<Orphan[]> {
		let files: string[];
		try {
			files = await readdir(PROC_DIR);
		} catch {
			return [];
		}
		const orphans: Orphan[] = [];
		for (const f of files) {
			if (!f.endsWith(".pid")) continue;
			const handle = f.slice(0, -4);
			if (this.procs.has(handle)) continue; // ours, this session
			try {
				const raw = JSON.parse(await readFile(join(PROC_DIR, f), "utf8")) as {
					pgid: number;
					startTicks?: string;
					command: string;
					name?: string;
					cwd?: string;
					startTime?: number;
				};
				if (!safeGroupId(raw.pgid) || !pgidAlive(raw.pgid)) {
					rmSync(join(PROC_DIR, f), { force: true }); // stale or corrupt pidfile
					continue;
				}
				// PID-reuse guard: the leader's current start ticks must match.
				const nowTicks = readStartTicks(raw.pgid);
				if (raw.startTicks && nowTicks && raw.startTicks !== nowTicks) {
					rmSync(join(PROC_DIR, f), { force: true }); // pgid recycled — not ours
					continue;
				}
				orphans.push({
					handle,
					pgid: raw.pgid,
					command: raw.command,
					name: raw.name,
					cwd: raw.cwd,
					startTime: raw.startTime,
				});
			} catch {
				// unreadable/corrupt pidfile — skip it, do not fail the whole scan
			}
		}
		return orphans;
	}

	/** Kill a specific orphan group (used after the user approves the reap prompt). */
	killOrphan(o: Orphan): void {
		killGroup(o.pgid, "SIGKILL");
		silent(() => rmSync(this.pidPath(o.handle), { force: true }));
	}

	/** SIGTERM every child this session owns and clear fds. Call on session_shutdown. */
	async shutdown(): Promise<void> {
		for (const [handle] of this.procs) {
			await this.stop(handle, 500);
		}
		for (const live of this.procs.values()) this.closeFd(live);
	}
}

export { MAX_LOG_LINES };
