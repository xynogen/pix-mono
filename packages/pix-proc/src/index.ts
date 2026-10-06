/**
 * pix-proc — run and manage long-lived processes (`npm run dev`, `vite`,
 * `python main.py`, watchers) that must outlive a single agent turn.
 *
 * Why a tool, not bash: bash blocks until exit and cannot supervise a running
 * process. `proc` starts a detached process, the child writes its own output to
 * a log file, and the tool manages it by handle — the same lifecycle shape as
 * the `download` tool in pix-aria2. See .pi/plans/pix-proc.md for the design.
 *
 * Gate: `proc start`'s command flows through pix-gate's unified command gate
 * (pix-gate adds `proc` to its tool set + reads `event.input.command`). Install
 * pix-gate for command gating on proc, same as bash.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { commandPreview } from "@xynogen/pix-pretty/command-preview";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { modalOverlayOptions } from "@xynogen/pix-pretty/modal-frame";
import {
	formatCollapsedToolRow,
	formatToolCallTitle,
	frameToolResult,
	getErrorMessage,
	hideCollapsedToolCall,
	rule,
} from "@xynogen/pix-pretty/utils";
import { type CollapseState, collapseDelayMs, tickCollapse } from "@xynogen/pix-runtime/collapse";
import { Type } from "typebox";
import { MAX_LOG_LINES, statusLine, statusWord } from "./format.ts";
import { ProcManager } from "./manager.ts";
import { MODAL_LOG_LINES, ProcModal, type ProcModalResult } from "./modal.ts";

const WIDGET_KEY = "pix-proc:procs";
const POLL_MS = 1000;

const ActionSchema = Type.Enum(["start", "list", "logs", "stop", "rm"] as const, {
	type: "string",
});

interface ProcResultDetails {
	_type: "procResult";
	action: string;
	ok: boolean;
	lines: string[];
	error?: string;
}

function textResult(details: ProcResultDetails) {
	return {
		content: [{ type: "text" as const, text: details.lines.join("\n") || `${details.action} ok` }],
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
const fail = (action: string, error: string): ProcResultDetails => ({
	_type: "procResult",
	action,
	ok: false,
	lines: [],
	error,
});

export default function registerRunner(pi: ExtensionAPI): void {
	const mgr = new ProcManager();
	let ui: ExtensionContext["ui"] | undefined;
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	const lastCleared = new Map<string, number>(); // handle → time it left "running"

	function startPolling(): void {
		if (pollTimer) return;
		pollTimer = setInterval(() => void tick(), POLL_MS);
	}

	async function tick(): Promise<void> {
		if (!ui) return;
		const now = Date.now();
		const all = mgr.list();
		for (const m of all) mgr.checkCap(m.handle);
		const running = all.filter((m) => m.status === "running");
		// Keep a just-finished row visible for collapseDelayMs, then drop it.
		const recent = all.filter((m) => {
			if (m.status === "running") {
				lastCleared.delete(m.handle);
				return false;
			}
			if (!lastCleared.has(m.handle)) lastCleared.set(m.handle, now);
			const at = lastCleared.get(m.handle) ?? now;
			return now - at < collapseDelayMs();
		});
		const visible = [...running, ...recent];
		if (visible.length === 0) {
			ui.setWidget(WIDGET_KEY, undefined);
			if (pollTimer) {
				clearInterval(pollTimer);
				pollTimer = undefined;
			}
			return;
		}
		// Widget shows status only — never the process's live output line.
		const rows = visible.map((m) => statusLine(m, now));
		ui.setWidget(
			WIDGET_KEY,
			(_tui, theme) => ({
				render: (width: number) => {
					const heading = `${theme.fg("accent", icon("process"))} ${theme.fg("accent", "Processes")}`;
					const body = rows.map((line) => truncateToWidth(`  ${theme.fg("dim", line)}`, width));
					return [
						rule(width, (glyphs) => theme.fg("borderMuted", glyphs)),
						truncateToWidth(heading, width),
						...body,
					];
				},
				invalidate() {},
			}),
			{ placement: "aboveEditor" },
		);
	}

	pi.on("session_start", async (_event, ctx) => {
		ui = ctx.ui;
		const orphans = await mgr.findOrphans();
		if (orphans.length === 0) return;
		const list = orphans.map((o) => `${o.handle} (${o.command})`).join(", ");
		// Never kill silently (§3): show, then ask.
		const choice = await ctx.ui.select(
			`pix-proc: ${orphans.length} orphaned process group(s) from a previous session — ${list}`,
			["Kill all", "Keep all"],
		);
		if (choice === "Kill all") {
			for (const o of orphans) mgr.killOrphan(o);
			ctx.ui.notify(`Killed ${orphans.length} orphaned process group(s).`, "warning");
			return;
		}
		if (choice === "Keep all") {
			for (const orphan of orphans) mgr.adoptOrphan(orphan);
			startPolling();
			await tick();
		}
	});

	pi.on("session_shutdown", async () => {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = undefined;
		}
		ui?.setWidget(WIDGET_KEY, undefined);
		await mgr.shutdown();
	});

	pi.registerTool({
		name: "proc",
		...({ exposure: "deferred" } as const),
		label: "Process",
		renderShell: "self",
		description:
			"Run and manage long-lived processes that outlive a turn (npm run dev, vite, python main.py, watchers). Actions: start <command> (returns a proc-* handle + first output), list (running processes), logs <handle> (new output since last read; tail <n> for last n lines), stop <handle>, rm <handle>. For one-shot commands use bash instead — start reports and steers you back when a command exits fast.",
		promptSnippet:
			"Run/manage long-lived processes via proc (start/list/logs/stop/rm). Use bash for one-shot commands.",
		parameters: Type.Object({
			action: ActionSchema,
			command: Type.Optional(
				Type.String({ description: "For start: the shell command to run (e.g. 'npm run dev')." }),
			),
			handle: Type.Optional(
				Type.String({ description: "For logs/stop/rm: the proc-* handle from start/list." }),
			),
			cwd: Type.Optional(
				Type.String({ description: "For start: working directory. Default cwd." }),
			),
			name: Type.Optional(
				Type.String({ description: "For start: a friendly label for the process." }),
			),
			tail: Type.Optional(
				Type.Integer({
					description: `For logs: return the last n lines instead of new-since-last-read (max ${MAX_LOG_LINES}).`,
				}),
			),
		}),
		renderCall(args, theme, context) {
			if (hideCollapsedToolCall(context.state as CollapseState, context.expanded, () => {}))
				return new Text("", 0, 0);
			const a = args as { action?: string; command?: string; handle?: string };
			const target = a.command ?? a.handle ?? "";
			return commandPreview(
				`${formatToolCallTitle(theme, "proc", context)} ${theme.fg("dim", a.action ?? "")}`,
				target,
				a.command ? "bash" : undefined,
				theme as unknown as { fg: (key: string, text: string) => string },
				context.state,
				context.invalidate,
				context.expanded,
			);
		},
		renderResult(result, options, theme, context) {
			const details = result.details as ProcResultDetails | undefined;
			const fallback = result.content
				.flatMap((part) => (part.type === "text" ? [part.text] : []))
				.join("\n");
			const body = details
				? details.ok
					? details.lines.join("\n") || `${details.action} ok`
					: (details.error ?? `${details.action} failed`)
				: fallback;
			const text = new Text(body, 0, 0);
			if (options.isPartial) return text;
			const failed = context.isError || details?.ok === false;
			if (
				tickCollapse("proc", context.state as CollapseState, context.invalidate, options.expanded)
			)
				return new Text(
					formatCollapsedToolRow(
						theme,
						"proc",
						body.replace(/\s+/g, " ").trim(),
						"",
						failed ? "error" : "success",
					),
					0,
					0,
				);
			return frameToolResult(text, theme, failed);
		},
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = params as {
				action: string;
				command?: string;
				handle?: string;
				cwd?: string;
				name?: string;
				tail?: number;
			};
			ui ??= ctx.ui;
			try {
				if (p.action === "start") return textResult(await doStart(p, ctx));
				if (p.action === "list") return textResult(doList());
				if (p.action === "logs") return textResult(await doLogs(p));
				if (p.action === "stop") return textResult(await doStop(p));
				if (p.action === "rm") return textResult(doRm(p));
				return textResult(fail(p.action, `unknown action ${p.action}`));
			} catch (err) {
				return textResult(fail(p.action, getErrorMessage(err)));
			}
		},
	});

	async function doStart(
		p: { command?: string; cwd?: string; name?: string },
		ctx: ExtensionContext,
	): Promise<ProcResultDetails> {
		if (!p.command?.trim()) return fail("start", "start requires a command");
		const meta = mgr.start(p.command, p.cwd ?? ctx.cwd, p.name);
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
		return ok("start", ...lines);
	}

	function doList(): ProcResultDetails {
		const all = mgr.list();
		if (all.length === 0) return ok("list", "no processes");
		return ok("list", ...all.map((m) => statusLine(m, Date.now())));
	}

	async function doLogs(p: { handle?: string; tail?: number }): Promise<ProcResultDetails> {
		if (!p.handle) return fail("logs", "logs requires a handle");
		if (typeof p.tail === "number") {
			const t = await mgr.logsTail(p.handle, p.tail);
			if (!t) return fail("logs", `unknown handle ${p.handle}`);
			const head = [`full log: ${t.logPath}`];
			if (t.capped)
				head.push("log capped at 50 MB — process still running, output no longer recorded");
			return ok("logs", ...head, ...(t.lines.length ? t.lines : ["(no output)"]));
		}
		const view = await mgr.logsSince(p.handle);
		if (!view) return fail("logs", `unknown handle ${p.handle}`);
		const head = [`full log: ${view.logPath}`];
		if (view.more > 0) head.push(`+${view.more} more, offset ${view.offset}`);
		if (view.capped)
			head.push("log capped at 50 MB — process still running, output no longer recorded");
		return ok("logs", ...head, ...(view.lines.length ? view.lines : ["(no new output)"]));
	}

	async function doStop(p: { handle?: string }): Promise<ProcResultDetails> {
		if (!p.handle) return fail("stop", "stop requires a handle");
		const r = await mgr.stop(p.handle);
		return r.ok ? ok("stop", r.note) : fail("stop", r.note);
	}

	function doRm(p: { handle?: string }): ProcResultDetails {
		if (!p.handle) return fail("rm", "rm requires a handle");
		const r = mgr.rm(p.handle);
		return r.ok ? ok("rm", r.note) : fail("rm", r.note);
	}

	// ── /proc user command — inspect + stop without the model ────────────────
	pi.registerCommand("proc", {
		description: "Manage long-lived processes: list, view logs, stop, remove (pix-proc)",
		handler: async (_args, ctx) => {
			if (typeof ctx.ui.custom === "function") {
				// Copies, so the modal can see a status change between refreshes.
				const snapshot = () => mgr.list().map((m) => ({ ...m }));
				let refresh: ReturnType<typeof setInterval> | undefined;
				const result = await ctx.ui
					.custom<ProcModalResult | undefined>(
						(tui, theme, kb, done) => {
							const modal = new ProcModal(
								snapshot(),
								async (h) => (await mgr.logsTail(h, MODAL_LOG_LINES))?.lines ?? [],
								tui,
								theme,
								kb,
								done,
							);
							refresh = setInterval(() => modal.refresh(snapshot()), POLL_MS);
							return modal;
						},
						{ overlay: true, overlayOptions: modalOverlayOptions() },
					)
					.finally(() => clearInterval(refresh));
				if (!result) return;
				const r = result.kind === "stop" ? await mgr.stop(result.handle) : mgr.rm(result.handle);
				ctx.ui.notify(r.note, r.ok ? "info" : "warning");
				return;
			}
			// No TUI (headless/RPC): a plain list is the only view.
			const all = mgr.list();
			ctx.ui.notify(
				all.length ? all.map((m) => statusLine(m, Date.now())).join("\n") : "no processes",
				"info",
			);
		},
	});
}
