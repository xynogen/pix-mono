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

import { showOverlay } from "@xynogen/pix-pretty/gate-overlay";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { modalOverlayOptions } from "@xynogen/pix-pretty/modal-frame";
import { truncateToWidth, visibleWidth } from "@xynogen/pix-pretty/tui";
import { getErrorMessage, rule, widgetTitle } from "@xynogen/pix-pretty/utils";
import { collapseDelayMs } from "@xynogen/pix-runtime/collapse";
import { type FSWatcher, watch } from "@xynogen/pix-runtime/fs";
import type { ExtensionAPI, ExtensionContext } from "@xynogen/pix-runtime/host";
import { once } from "@xynogen/pix-runtime/once";
import { Type } from "typebox";
import { fail, type ProcParams, runAction, textResult } from "./actions.ts";
import { MAX_LOG_LINES, type ProcMeta, procLabel, statusLine } from "./format.ts";
import { PROC_DIR, ProcManager } from "./manager.ts";
import { MODAL_LOG_LINES, ProcModal, type ProcModalResult } from "./modal.ts";
import { renderProcCall, renderProcResult } from "./render.ts";
import { processRow } from "./widget.ts";

const WIDGET_KEY = "pix-proc:procs";
const POLL_MS = 1000;

const ActionSchema = Type.Enum(["start", "list", "logs", "stop", "rm"] as const, {
	type: "string",
});

export default function registerRunner(pi: ExtensionAPI): void {
	once(pi, "pix-proc", () => register(pi));
}

function register(pi: ExtensionAPI): void {
	const mgr = new ProcManager();
	let ui: ExtensionContext["ui"] | undefined;
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	const lastCleared = new Map<string, number>(); // handle → time it left "running"

	function startPolling(): void {
		if (pollTimer) return;
		pollTimer = setInterval(() => void tick(), POLL_MS);
	}

	// Wake the idle widget when another agent writes a pidfile. inotify-backed:
	// no polling while nothing runs; the 1s tick only runs while rows are shown.
	let watcher: FSWatcher | undefined;
	function watchProcDir(): void {
		if (watcher) return;
		try {
			watcher = watch(PROC_DIR, { persistent: false }, (_event, file) => {
				if (file?.endsWith(".pid")) startPolling();
			});
			watcher.on("error", () => {
				watcher?.close();
				watcher = undefined;
			});
		} catch {
			// No fs.watch (some network mounts): foreign rows still show while our own poll runs.
		}
	}

	/** Running rows plus just-finished ones for collapseDelayMs — shared by widget and /proc. */
	function visibleProcs(now: number): ProcMeta[] {
		const all = mgr.list();
		for (const m of all) mgr.checkCap(m.handle);
		const running = all.filter((m) => m.status === "running");
		const recent = all.filter((m) => {
			if (m.status === "running") {
				lastCleared.delete(m.handle);
				return false;
			}
			if (!lastCleared.has(m.handle)) lastCleared.set(m.handle, now);
			const at = lastCleared.get(m.handle) ?? now;
			return now - at < collapseDelayMs();
		});
		return [...running, ...mgr.foreign(), ...recent];
	}

	async function tick(): Promise<void> {
		if (!ui) return;
		const now = Date.now();
		const visible = visibleProcs(now);
		if (visible.length === 0) {
			ui.setWidget(WIDGET_KEY, undefined);
			if (pollTimer) {
				clearInterval(pollTimer);
				pollTimer = undefined;
			}
			return;
		}
		// Widget shows status only — never the process's live output line.
		ui.setWidget(
			WIDGET_KEY,
			(_tui, theme) => ({
				render: (width: number) => {
					if (width < 1) return [];
					const heading = widgetTitle(theme, icon("process"), "Proc");
					const headingWidth = visibleWidth(heading);
					const body = visible.map((m, i) =>
						truncateToWidth(
							(i === 0 ? heading : widgetTitle(theme, "", "")) +
								processRow(
									m,
									m.status === "running" ? now : (lastCleared.get(m.handle) ?? now),
									Math.max(0, width - headingWidth),
									theme,
								),
							width,
						),
					);
					return [rule(width, (glyphs) => theme.fg("borderMuted", glyphs)), ...body];
				},
				invalidate() {},
			}),
			{ placement: "aboveEditor" },
		);
	}

	pi.on("session_start", async (_event, ctx) => {
		ui = ctx.ui;
		watchProcDir();
		if (mgr.foreign().length > 0) startPolling();
		const orphans = await mgr.findOrphans();
		if (orphans.length === 0) return;
		const title = `${orphans.length} orphaned process group(s) from a previous session`;
		const labels = orphans.map((o) => `${o.handle} (${procLabel(o)})`);
		// Never kill silently (§3): show, then ask. Keep is first so a reflexive Enter is safe.
		const choice =
			typeof ctx.ui.custom === "function"
				? (
						await showOverlay(ctx.ui, {
							mode: "confirm",
							icon: icon("process"),
							title,
							body: labels,
							choices: [
								{ value: "Keep all", label: "Keep all", description: "Adopt and track them" },
								{ value: "Kill all", label: "Kill all", description: "Terminate every group" },
							],
							approveValue: ["Keep all", "Kill all"],
						})
					).choice
				: await ctx.ui.select(`pix-proc: ${title} — ${labels.join(", ")}`, [
						"Keep all",
						"Kill all",
					]);
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
		watcher?.close();
		watcher = undefined;
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
		promptGuidelines: [
			'proc: dev servers, watchers and other commands that never exit go here, not in bash (no `&`, no sleep polling). Load read_skills(name="pix-proc", full=true) for patterns.',
		],
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
		renderCall: (args, theme, context) => renderProcCall(args, theme, context),
		renderResult: (result, options, theme, context) =>
			renderProcResult(result, options, theme, context),
		async execute(_id, params, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			const p = params as ProcParams;
			ui ??= ctx.ui;
			try {
				return textResult(await runAction(mgr, p, ctx.cwd, startPolling));
			} catch (err) {
				return textResult(fail(p.action, getErrorMessage(err)));
			}
		},
	});

	// ── /proc user command — inspect + stop without the model ────────────────
	pi.registerCommand("proc", {
		description: "Manage long-lived processes: list, view logs, stop, remove (pix-proc)",
		handler: async (_args, ctx) => {
			if (typeof ctx.ui.custom === "function") {
				// Copies, so the modal can see a status change between refreshes.
				const snapshot = () => visibleProcs(Date.now()).map((m) => ({ ...m }));
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
