/**
 * Pure helpers for the process runner — log slicing, cursor math, status lines.
 * Kept free of fs/spawn so they unit-test without a real process or TUI.
 */

/** Live process metadata the renderer + list read. */
export interface ProcMeta {
	handle: string;
	command: string;
	cwd: string;
	name?: string;
	pid: number;
	pgid: number;
	startTime: number; // ms epoch
	startTicks?: string; // /proc/<pid>/stat field 22, for PID-reuse-safe reap
	status: "running" | "exited" | "killed";
	exitCode?: number;
	capped: boolean;
	/** Why output stopped being recorded, or why the spawn failed. */
	logError?: string;
}

export const MAX_LOG_LINES = 1000;

/**
 * Split a full log text into complete lines, dropping a trailing partial line
 * (no newline yet). Returns the complete lines and the byte offset up to and
 * including the last newline — the safe cursor position.
 */
export function completeLines(text: string): { lines: string[]; offset: number } {
	const lastNl = text.lastIndexOf("\n");
	if (lastNl < 0) return { lines: [], offset: 0 };
	const complete = text.slice(0, lastNl); // exclude the final newline itself
	const offset = lastNl + 1; // byte after the last newline
	return { lines: complete.length ? complete.split("\n") : [], offset };
}

/** Tail slice: last `n` lines (n clamped to [1, MAX_LOG_LINES]). */
export function tailLines(lines: string[], n: number): string[] {
	const count = Math.min(Math.max(1, Math.floor(n)), MAX_LOG_LINES);
	return lines.slice(-count);
}

export interface LogView {
	lines: string[];
	offset: number; // new cursor for the caller to store
	more: number; // lines beyond the returned slice
}

/**
 * Cursor-based read. Given the full log text and the caller's previous byte
 * cursor, return the new complete lines since the cursor, clamped to
 * MAX_LOG_LINES (newest kept), plus the advanced cursor and a `more` count.
 */
export function logSince(text: string, cursor: number): LogView {
	const fresh = text.slice(Math.max(0, Math.min(cursor, text.length)));
	const { lines, offset } = completeLines(fresh);
	const newCursor = Math.max(0, Math.min(cursor, text.length)) + offset;
	if (lines.length <= MAX_LOG_LINES) return { lines, offset: newCursor, more: 0 };
	return {
		lines: lines.slice(-MAX_LOG_LINES),
		offset: newCursor,
		more: lines.length - MAX_LOG_LINES,
	};
}

/** Human uptime `2m14s`, `1h03m`, `9s`. */
export function humanUptime(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/** Short status word for list/widget. */
export function statusWord(m: ProcMeta): string {
	if (m.status === "running") return "running";
	if (m.status === "killed") return "killed";
	return `exited(${m.exitCode ?? "?"})`;
}

const SECRET_KEY = /PASS|TOKEN|SECRET|KEY/i;

/**
 * UI label for a process: first non-empty command line, whitespace collapsed,
 * ` …` when the command spans more lines, and secret-looking `KEY=value`
 * assignments masked as `KEY=***`. Display only — the real command runs as is.
 */
export function procLabel(m: Pick<ProcMeta, "command" | "name">): string {
	const lines = m.command.split("\n").filter((l) => l.trim());
	const first = (lines[0] ?? "").replace(/\s+/g, " ").trim();
	const masked = first.replace(
		/\b([A-Za-z_][A-Za-z0-9_]*)=('[^']*'|"[^"]*"|\S+)/g,
		(all, key: string) => (SECRET_KEY.test(key) ? `${key}=***` : all),
	);
	const command = lines.length > 1 ? `${masked} …` : masked;
	return m.name ? `${m.name} (${command})` : command;
}

/**
 * One-line summary, e.g.
 * `proc-swift-otter-42 · npm run dev · 2m14s · running · Local: http://…`.
 * `lastLine` is the freshest output line (already trimmed by the caller).
 */
export function statusLine(m: ProcMeta, now: number, lastLine?: string): string {
	const label = procLabel(m);
	const parts = [m.handle, label, humanUptime(now - m.startTime), statusWord(m)];
	if (m.capped) parts.push("capped");
	if (lastLine) parts.push(lastLine.replace(/\s+/g, " ").trim());
	return parts.filter(Boolean).join(" · ");
}
