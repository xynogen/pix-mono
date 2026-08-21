/**
 * index.ts — pix-subagent extension entry point.
 *
 * Registers 4 LLM-callable tools (agent, agent_info, agent_result, agent_steer),
 * a live above-editor widget (model shown inline), and a themed
 * subagent-notification renderer.
 *
 * Best-of-both:
 *   - tintinweb/pi-subagents spawn engine (MIT) — battle-tested createAgentSession path
 *   - nicobailon/pi-subagents explicit work-splitting (allowed_tools[], model param)
 *   - pix twist: model name ALWAYS visible in widget + notification
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "./agent-manager.ts";
import { registerAgents } from "./agent-types.ts";
import { loadCustomAgents } from "./custom-agents.ts";
import {
	type AgentActivity,
	createAgentInfoTool,
	createAgentResultTool,
	createAgentSteerTool,
	createAgentTool,
} from "./tools.ts";
import type { NotificationDetails } from "./types.ts";
import { registerNotificationRenderer } from "./ui/notification.ts";
import { AgentWidget } from "./ui/widget.ts";
import { getSessionContextUsage, type SessionLike } from "./usage.ts";

const EXTENSION_KEY = "pix-subagent";

// Reload guard key — stored on globalThis so a dev-reload cleans up stale state
const CLEANUP_KEY = `__${EXTENSION_KEY}Cleanup`;

export default function registerPixSubagent(pi: ExtensionAPI): void {
	// ── Cleanup stale timers from a prior reload ───────────────────────────────
	const g = globalThis as Record<string, unknown>;
	const prevCleanup = g[CLEANUP_KEY];
	if (typeof prevCleanup === "function") {
		try {
			(prevCleanup as () => void)();
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

	// Debounce: brief hold so agent_result can cancel a notification it just consumed
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
						content: `Agent "${record.description}" ${record.status}.`,
						display: true,
						details,
					},
					// A background agent completes asynchronously, usually while the
					// parent is idle. "followUp" parks the notification in the follow-up
					// queue and only flushes it on the NEXT user prompt — so the result
					// appears to "only show up after you poke it with a chat". "steer"
					// delivers at the next tool-call boundary while streaming, and
					// triggerTurn fires an immediate turn when idle, so the notification
					// surfaces consistently in both cases (cf. the file-trigger example).
					{ deliverAs: "steer", triggerTurn: true },
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
	// Volatile type/model catalogs stay behind agent_info rather than bloating
	// every prompt. Invalid explicit models still return the live catalog.
	pi.registerTool(createAgentInfoTool(reloadCustomAgents));
	pi.registerTool(
		createAgentTool(
			pi as Parameters<typeof manager.spawn>[0],
			manager,
			agentActivity,
			reloadCustomAgents,
		),
	);
	pi.registerTool(createAgentResultTool(manager, agentActivity));
	pi.registerTool(createAgentSteerTool(manager));

	// ── Lifecycle ──────────────────────────────────────────────────────────────
	pi.on("session_start", (_event, ctx) => {
		manager.clearCompleted();
		agentActivity.clear();
		// Capture the session-stable UI ctx (like pix-commands /btw). turn_start
		// alone is not enough: a background agent outlives its launching turn, and
		// once that turn ends the turn_start-captured ctx goes stale — setWidget/
		// requestRender then no-op and the live agent row vanishes though it runs.
		widget.setUICtx(ctx.ui as Parameters<typeof widget.setUICtx>[0]);
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
		for (const t of pendingNudges.values()) clearTimeout(t);
		pendingNudges.clear();
		manager.abortAll();
		manager.dispose();
		widget.dispose();
		agentActivity.clear();
	};

	pi.on("session_shutdown", () => {
		runtimeCleanup();
		if (g[CLEANUP_KEY] === runtimeCleanup) delete g[CLEANUP_KEY];
	});
	g[CLEANUP_KEY] = runtimeCleanup;
}
