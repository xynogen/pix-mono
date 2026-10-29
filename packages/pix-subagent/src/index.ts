/**
 * index.ts — pix-subagent extension entry point.
 *
 * Registers 2 LLM-callable tools (agent, agent_control),
 * a live above-editor widget (model shown inline), and a themed
 * subagent-notification renderer.
 *
 * Best-of-both:
 *   - tintinweb/pi-subagents spawn engine (MIT) — battle-tested createAgentSession path
 *   - nicobailon/pi-subagents explicit work-splitting (allowed_tools[], model param)
 *   - pix twist: model name ALWAYS visible in widget + notification
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "./agent-manager.ts";
import { registerAgents } from "./agent-types.ts";
import { loadCustomAgents } from "./custom-agents.ts";
import { type AgentActivity, createAgentControlTool, createAgentTool } from "./tools.ts";
import type { NotificationDetails } from "./types.ts";
import { registerNotificationRenderer } from "./ui/notification.ts";
import { AgentWidget } from "./ui/widget.ts";
import { getSessionContextUsage, type SessionLike } from "./usage.ts";

const EXTENSION_KEY = "pix-subagent";

// Reload guard — keyed per `pi` host so a dev-reload on the SAME host cleans
// up stale state, while a child subagent session (which loads this extension
// again with its OWN `pi`) never disposes the parent's manager. A plain
// globalThis function slot did exactly that: every spawn wiped the parent's
// agent map, so agent_control saw "(none)" / "Agent not found" as soon as a
// child booted. Lives on globalThis because jiti re-evaluates this module.
const CLEANUP_KEY = `__${EXTENSION_KEY}Cleanup`;
const cleanupByHost: WeakMap<object, () => void> = (() => {
	const g = globalThis as { [CLEANUP_KEY]?: WeakMap<object, () => void> };
	if (!g[CLEANUP_KEY]) g[CLEANUP_KEY] = new WeakMap();
	return g[CLEANUP_KEY];
})();

export default function registerPixSubagent(pi: ExtensionAPI): void {
	// ── Cleanup stale timers from a prior reload ───────────────────────────────
	const prevCleanup = cleanupByHost.get(pi);
	if (prevCleanup) {
		try {
			prevCleanup();
		} catch {
			/* best effort */
		}
	}

	// ── Agent registry ─────────────────────────────────────────────────────────
	const reloadCustomAgents = () => {
		const userAgents = loadCustomAgents(process.cwd());
		registerAgents(userAgents);
	};
	reloadCustomAgents();

	// ── State ──────────────────────────────────────────────────────────────────
	const agentActivity = new Map<string, AgentActivity>();
	let parentContext: ExtensionContext | undefined;
	let parentInterrupted = false;

	// Debounce: brief hold so agent_control can cancel a notification it just consumed
	const pendingNudges = new Map<string, ReturnType<typeof setTimeout>>();
	const NUDGE_HOLD_MS = 200;

	function scheduleNudge(key: string, send: () => void) {
		cancelNudge(key);
		pendingNudges.set(
			key,
			setTimeout(() => {
				pendingNudges.delete(key);
				try {
					send();
				} catch {
					/* ignore stale context errors */
				}
			}, NUDGE_HOLD_MS),
		);
	}

	function cancelNudge(key: string) {
		const t = pendingNudges.get(key);
		if (t != null) {
			clearTimeout(t);
			pendingNudges.delete(key);
		}
	}

	// ── AgentManager ──────────────────────────────────────────────────────────
	const manager = new AgentManager(
		// onComplete — fire subagent-notification nudge for each finished bg agent
		(record) => {
			const act = agentActivity.get(record.id);
			if (act) record.streamingMs = act.streamingMs;
			agentActivity.delete(record.id);

			if (record.resultConsumed) {
				widget.update();
				return;
			}

			const terminalStatus = record.status;
			if (terminalStatus === "running" || terminalStatus === "queued") {
				widget.update();
				return;
			}

			const contextUsage = record.session
				? getSessionContextUsage(record.session as SessionLike)
				: null;
			const resultTruncated = (record.result?.length ?? 0) > 500;
			const resultPreview = record.result
				? resultTruncated
					? `${record.result.slice(0, 500)}…`
					: record.result
				: "No output.";

			const details: NotificationDetails = {
				id: record.id,
				description: record.description,
				status: terminalStatus,
				modelName: record.invocation?.modelName,
				toolUses: record.toolUses,
				turnCount: record.turnCount,
				maxTurns: record.maxTurns,
				contextUsage,
				outputTokens: record.lifetimeUsage.output,
				streamingMs: record.streamingMs,
				durationMs: record.completedAt ? record.completedAt - record.startedAt : 0,
				error: record.error,
				resultPreview,
				resultTruncated,
			};

			scheduleNudge(record.id, () => {
				if (record.resultConsumed) {
					widget.update();
					return;
				}
				pi.sendMessage<NotificationDetails>(
					{
						customType: "subagent-notification",
						content: `Agent ${record.id} "${record.description}" ${record.status}.\n${record.error ?? resultPreview}${resultTruncated ? `\nUse agent_control(action:"result", agent_id:"${record.id}") for full output.` : ""}${record.invocation?.remind && (record.status === "completed" || record.status === "steered") ? "\nContinue the main task using this result." : ""}`,
						display: true,
						details,
					},
					{
						deliverAs: "steer",
						triggerTurn:
							record.invocation?.remind === true &&
							parentContext?.mode === "tui" &&
							parentContext.isIdle() &&
							!parentContext.hasPendingMessages() &&
							!parentInterrupted &&
							(record.status === "completed" || record.status === "steered"),
					},
				);
			});

			widget.update();
		},
		4, // maxConcurrent
		// onStart — re-arm the 80ms spinner loop. update() clears the timer when
		// the last agent finishes; a fresh spawn mid-turn (no new turn_start) must
		// restart it or the spinner freezes on one frame.
		(_record) => {
			widget.ensureTimer();
			widget.update();
		},
	);

	// ── Widget ─────────────────────────────────────────────────────────────────
	const widget = new AgentWidget(manager, agentActivity);

	// ── Register renderers ─────────────────────────────────────────────────────
	registerNotificationRenderer(pi);

	// ── Register tools ─────────────────────────────────────────────────────────
	// One action-based gateway keeps control/discovery schemas out of the baseline.
	pi.registerTool(
		createAgentTool(
			pi as Parameters<typeof manager.spawn>[0],
			manager,
			agentActivity,
			reloadCustomAgents,
		),
	);
	pi.registerTool(createAgentControlTool(manager, agentActivity, reloadCustomAgents));

	// ── Lifecycle ──────────────────────────────────────────────────────────────
	pi.on("session_start", (_event, ctx) => {
		parentContext = ctx;
		parentInterrupted = false;
		manager.clearCompleted();
		agentActivity.clear();
		// Capture the session-stable UI ctx (like pix-commands /btw). turn_start
		// alone is not enough: a background agent outlives its launching turn, and
		// once that turn ends the turn_start-captured ctx goes stale — setWidget/
		// requestRender then no-op and the live agent row vanishes though it runs.
		widget.setUICtx(ctx.ui as Parameters<typeof widget.setUICtx>[0]);
	});

	pi.on("before_agent_start", (event) => {
		if (event.messageType === "user") parentInterrupted = false;
	});
	pi.on("agent_end", (event) => {
		const last = [...event.messages].reverse().find((message) => message.role === "assistant");
		if (
			last?.role === "assistant" &&
			(last.stopReason === "aborted" || last.stopReason === "error")
		) {
			parentInterrupted = true;
		}
	});
	pi.on("agent_settled", (event) => {
		if (event.aborted) parentInterrupted = true;
	});

	pi.on("turn_start", () => {
		// UI ctx is captured once at session_start (session-stable). Re-capturing a
		// per-turn ctx here would swap to a handle that dies when the turn ends,
		// which is exactly what made a still-running background agent's row vanish.
		widget.onTurnStart();
		widget.ensureTimer();
	});

	let disposed = false;
	const runtimeCleanup = () => {
		if (disposed) return;
		disposed = true;
		parentContext = undefined;
		for (const t of pendingNudges.values()) clearTimeout(t);
		pendingNudges.clear();
		manager.abortAll();
		manager.dispose();
		widget.dispose();
		agentActivity.clear();
	};

	pi.on("session_shutdown", () => {
		runtimeCleanup();
		if (cleanupByHost.get(pi) === runtimeCleanup) cleanupByHost.delete(pi);
	});
	cleanupByHost.set(pi, runtimeCleanup);
}
