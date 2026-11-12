/** proc tool actions: start, list, logs, stop, rm. Each returns result details. */

import { type ProcMeta, statusLine, statusWord } from "./format.ts";
import type { ProcManager } from "./manager.ts";

export interface ProcResultDetails {
	_type: "procResult";
	action: string;
	ok: boolean;
	lines: string[];
	error?: string;
	handle?: string;
	processes?: ProcMeta[];
	output?: string[];
	notes?: string[];
	logPath?: string;
}

export interface ProcParams {
	action: string;
	command?: string;
	handle?: string;
	cwd?: string;
	name?: string;
	tail?: number;
}

export function textResult(details: ProcResultDetails) {
	return {
		content: [
			{
				type: "text" as const,
				text: details.error ?? (details.lines.join("\n") || `${details.action} ok`),
			},
		],
		details,
		isError: !details.ok,
	};
}

const ok = (action: string, ...lines: string[]): ProcResultDetails => ({
	_type: "procResult",
	action,
	ok: true,
	lines,
});
export const fail = (action: string, error: string): ProcResultDetails => ({
	_type: "procResult",
	action,
	ok: false,
	lines: [],
	error,
});

async function doStart(
	mgr: ProcManager,
	p: ProcParams,
	cwd: string,
	startPolling: () => void,
): Promise<ProcResultDetails> {
	if (!p.command?.trim()) return fail("start", "start requires a command");
	const meta = mgr.start(p.command, p.cwd ?? cwd, p.name);
	startPolling();
	// Short wait window: first output, or exit, or 1s. Return status + first lines.
	const start = Date.now();
	while (Date.now() - start < 1000) {
		await new Promise((r) => setTimeout(r, 100));
		if (meta.status !== "running") break;
		const line = await mgr.lastLine(meta.handle);
		if (line) break;
	}
	const view = await mgr.logsSince(meta.handle);
	const lines = [`${meta.handle} started — ${p.command} (pid ${meta.pid})`];
	if (view?.lines.length) lines.push(...view.lines);
	if (meta.status !== "running") {
		lines.push(`${statusWord(meta)} in <1s — use bash for one-shot commands`);
	}
	return {
		...ok("start", ...lines),
		handle: meta.handle,
		processes: [{ ...meta }],
		output: view?.lines ?? [],
		notes: meta.status !== "running" ? [lines.at(-1)!] : [],
	};
}

function doList(mgr: ProcManager): ProcResultDetails {
	const all = [...mgr.list(), ...mgr.foreign()];
	if (all.length === 0) return { ...ok("list", "no processes"), processes: [], output: [] };
	return {
		...ok("list", ...all.map((m) => statusLine(m, Date.now()))),
		processes: all.map((m) => ({ ...m })),
	};
}

const LOG_CAPPED = "log capped at 50 MB — process still running, output no longer recorded";

async function doLogs(mgr: ProcManager, p: ProcParams): Promise<ProcResultDetails> {
	if (!p.handle) return fail("logs", "logs requires a handle");
	if (typeof p.tail === "number") {
		const t = await mgr.logsTail(p.handle, p.tail);
		if (!t) return fail("logs", `unknown handle ${p.handle}`);
		const head = [`full log: ${t.logPath}`];
		if (t.logError) head.push(`log stopped: ${t.logError} — process may still be running`);
		else if (t.capped) head.push(LOG_CAPPED);
		const output = t.lines.length ? t.lines : ["(no output)"];
		return {
			...ok("logs", ...head, ...output),
			handle: p.handle,
			logPath: t.logPath,
			notes: head.slice(1),
			output,
		};
	}
	const view = await mgr.logsSince(p.handle);
	if (!view) return fail("logs", `unknown handle ${p.handle}`);
	const head = [`full log: ${view.logPath}`];
	if (view.more > 0) head.push(`+${view.more} more, offset ${view.offset}`);
	if (view.logError) head.push(`log stopped: ${view.logError} — process may still be running`);
	else if (view.capped) head.push(LOG_CAPPED);
	const output = view.lines.length ? view.lines : ["(no new output)"];
	return {
		...ok("logs", ...head, ...output),
		handle: p.handle,
		logPath: view.logPath,
		notes: head.slice(1),
		output,
	};
}

/** stop and rm share one result shape: the manager's note, no output. */
function noteResult(action: string, handle: string, r: { ok: boolean; note: string }) {
	return {
		...(r.ok ? ok(action, r.note) : fail(action, r.note)),
		handle,
		notes: r.ok ? [r.note] : [],
		output: [],
	};
}

export async function runAction(
	mgr: ProcManager,
	p: ProcParams,
	cwd: string,
	startPolling: () => void,
): Promise<ProcResultDetails> {
	if (p.action === "start") return doStart(mgr, p, cwd, startPolling);
	if (p.action === "list") return doList(mgr);
	if (p.action === "logs") return doLogs(mgr, p);
	if (p.action === "stop") {
		if (!p.handle) return fail("stop", "stop requires a handle");
		return noteResult("stop", p.handle, await mgr.stop(p.handle));
	}
	if (p.action === "rm") {
		if (!p.handle) return fail("rm", "rm requires a handle");
		return noteResult("rm", p.handle, mgr.rm(p.handle));
	}
	return fail(p.action, `unknown action ${p.action}`);
}
