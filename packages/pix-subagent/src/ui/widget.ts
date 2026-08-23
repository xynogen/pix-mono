/**
 * ui/widget.ts — Persistent above-editor widget showing running/completed agents.
 *
 * Pix twist vs tintinweb: model name is ALWAYS shown inline in the header line
 * (e.g. "Explore [haiku]") even when it matches the parent model. Types and
 * formatting helpers are re-exported from tools.ts to avoid circular deps.
 *
 * Ported from tintinweb/pi-subagents (MIT), adapted for pix-mono.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { COLLAPSED_TOOL_GLYPH, dotJoin, padIcon } from "@xynogen/pix-pretty/utils";
import type { AgentManager } from "../agent-manager.ts";
import { getConfig } from "../agent-types.ts";
import type { AgentActivity, AgentDetails, Theme } from "../tools.ts";
import {
	describeActivity,
	formatContext,
	formatMs,
	formatSpeed,
	formatTokens,
	formatToolUses,
	formatTurns,
	SPINNER,
} from "../tools.ts";
import type { AgentInvocation, SubagentType } from "../types.ts";
import { type ContextUsageLike, getSessionContextUsage, type SessionLike } from "../usage.ts";

export type { AgentActivity, AgentDetails, Theme };
export {
	describeActivity,
	formatContext,
	formatMs,
	formatSpeed,
	formatTokens,
	formatToolUses,
	formatTurns,
	SPINNER,
};

// ── constants ─────────────────────────────────────────────────────────────────

const MAX_WIDGET_LINES = 12;

export const ERROR_STATUSES = new Set(["error", "aborted", "stopped"]);

// ── UICtx type ────────────────────────────────────────────────────────────────

export type UICtx = {
	theme: Theme;
	setStatus(key: string, text: string | undefined): void;
	setWidget(
		key: string,
		content:
			| undefined
			| ((tui: unknown, theme: Theme) => { render(): string[]; invalidate(): void }),
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
};

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Format context-window utilization for the widget, with optional compaction
 * count annotation. Returns "" when context percent is unavailable.
 */
export function formatSessionContext(
	usage: ContextUsageLike | null,
	theme: Theme,
	compactions = 0,
	// plain=true returns uncolored text (no embedded ANSI reset) so the caller
	// can wrap the whole stats tail in one uniform color. Colored mode keeps the
	// warning/error tint at high context utilization.
	plain = false,
): string {
	if (usage?.percent == null && compactions === 0) return "";
	const base = formatContext(usage);
	if (plain) {
		if (compactions > 0) return base ? `${base} (⇊${compactions})` : `⇊${compactions}`;
		return base;
	}
	const color =
		usage?.percent != null && usage.percent >= 85
			? "error"
			: usage?.percent != null && usage.percent >= 70
				? "warning"
				: "dim";
	if (compactions > 0) {
		const compactStr = theme.fg("dim", `⇊${compactions}`);
		if (!base) return compactStr;
		return `${theme.fg(color, base)} ${theme.fg("dim", "(")}${compactStr}${theme.fg("dim", ")")}`;
	}
	return base ? theme.fg(color, base) : "";
}

export function getDisplayName(type: SubagentType): string {
	return getConfig(type).displayName;
}

export function getPromptModeLabel(type: SubagentType): string | undefined {
	return getConfig(type).promptMode === "append" ? "fork" : undefined;
}

export function buildInvocationTags(invocation: AgentInvocation | undefined): {
	modelName?: string;
	tags: string[];
} {
	const tags: string[] = [];
	if (!invocation) return { tags };
	if (invocation.thinking) tags.push(`thinking: ${invocation.thinking}`);
	if (invocation.isolated) tags.push("isolated");
	if (invocation.inheritContext) tags.push("inherit ctx");

	if (invocation.maxTurns != null) tags.push(`max: ${invocation.maxTurns}`);
	return { modelName: invocation.modelName, tags };
}

// describeActivity imported from ../tools.ts

// ── AgentWidget ───────────────────────────────────────────────────────────────

export class AgentWidget {
	private uiCtx: UICtx | undefined;
	private widgetFrame = 0;
	private widgetInterval: ReturnType<typeof setInterval> | undefined;
	private lingerTimeout: ReturnType<typeof setTimeout> | undefined;
	private static readonly FINISHED_LINGER_MS = 5_000;
	private static readonly ERROR_LINGER_MS = 15_000;
	private widgetRegistered = false;
	private tui: unknown = undefined;
	private lastStatusText: string | undefined;

	constructor(
		private manager: AgentManager,
		private agentActivity: Map<string, AgentActivity>,
	) {}

	setUICtx(ctx: UICtx) {
		if (ctx !== this.uiCtx) {
			this.uiCtx = ctx;
			this.widgetRegistered = false;
			this.tui = undefined;
			this.lastStatusText = undefined;
		}
	}

	onTurnStart() {
		this.update();
	}

	ensureTimer() {
		// Cancel any pending linger-only timeout — the fast interval supersedes it.
		if (this.lingerTimeout) {
			clearTimeout(this.lingerTimeout);
			this.lingerTimeout = undefined;
		}
		if (!this.widgetInterval) {
			this.widgetInterval = setInterval(() => this.update(), 80);
		}
	}

	private shouldShowFinished(status: string, completedAt: number, isBackground?: boolean): boolean {
		// Foreground agents show their result inline in the transcript — no need
		// to linger in the widget. Only background agents get the finished line.
		if (!isBackground) return false;
		// Linger a few seconds after finish, then drop. The notification is the
		// permanent record; errors stay longer so failures are noticed.
		const linger = ERROR_STATUSES.has(status)
			? AgentWidget.ERROR_LINGER_MS
			: AgentWidget.FINISHED_LINGER_MS;
		return Date.now() - completedAt < linger;
	}

	private renderFinishedLine(
		a: {
			id: string;
			type: SubagentType;
			status: string;
			description: string;
			toolUses: number;
			startedAt: number;
			completedAt?: number;
			error?: string;
			invocation?: AgentInvocation;
			lifetimeUsage?: { input: number; output: number; cacheWrite: number };
			session?: unknown;
			compactionCount?: number;
			turnCount?: number;
			maxTurns?: number;
			streamingMs?: number;
		},
		theme: Theme,
	): string {
		const name = getDisplayName(a.type);
		const modeLabel = getPromptModeLabel(a.type);
		const durationMs = (a.completedAt ?? Date.now()) - a.startedAt;
		const duration = formatMs(durationMs);

		// model label (the pix twist — always shown)
		const modelLabel = a.invocation?.modelName
			? ` ${theme.fg("muted", `[${a.invocation.modelName}]`)}`
			: "";
		const modeTag = modeLabel ? ` ${theme.fg("dim", `(${modeLabel})`)}` : "";

		let icon: string;
		let statusText: string;
		// Markers are width-normalized (padIcon) so wide `⚠` (aborted) aligns with
		// the 1-cell `✓`/`✗`/`■` siblings when finished rows stack in the widget.
		if (a.status === "completed") {
			icon = theme.fg("success", padIcon("✓"));
			statusText = "";
		} else if (a.status === "steered") {
			icon = theme.fg("success", padIcon("✓"));
			statusText = theme.fg("dim", " (turn limit)");
		} else if (a.status === "stopped") {
			icon = theme.fg("dim", padIcon("■"));
			statusText = theme.fg("dim", " stopped");
		} else if (a.status === "error") {
			icon = theme.fg("error", padIcon("✗"));
			const errMsg = a.error ? `: ${a.error.slice(0, 60)}` : "";
			statusText = theme.fg("error", ` error${errMsg}`);
		} else {
			icon = theme.fg("warning", padIcon(COLLAPSED_TOOL_GLYPH.warning));
			statusText = theme.fg("warning", " aborted");
		}

		const parts: string[] = [];
		// Turns read from the record (a.*), not agentActivity — onComplete deletes
		// the activity entry before this line renders, which had dropped ↻N.
		if (a.turnCount != null && a.turnCount > 0) parts.push(formatTurns(a.turnCount, a.maxTurns));
		if (a.toolUses > 0) parts.push(formatToolUses(a.toolUses));
		// Context% + speed read from the record (survives the
		// agentActivity delete that fires in onComplete before this renders).
		// plain=true: no embedded color/reset, so the single outer dim wrap below
		// tints the whole stats tail uniformly (no white-leak past ctxText).
		const contextUsage = a.session ? getSessionContextUsage(a.session as SessionLike) : null;
		const ctxText = formatSessionContext(contextUsage, theme, a.compactionCount ?? 0, true);
		if (ctxText) parts.push(ctxText);
		const speed = formatSpeed(a.lifetimeUsage?.output ?? 0, a.streamingMs ?? durationMs);
		if (speed) parts.push(speed);
		parts.push(duration);

		const dot = (s: string) => theme.fg("dim", s);
		return `${dotJoin([`${icon} ${theme.fg("dim", name)}${modelLabel}${modeTag}`, theme.fg("dim", a.description), theme.fg("dim", dotJoin(parts))], dot)}${statusText}`;
	}

	private renderWidget(
		tui: { terminal: { columns: number }; requestRender?: () => void },
		theme: Theme,
	): string[] {
		const allAgents = this.manager.listAgents();
		// Only show background running agents — foreground agents already have
		// a live inline transcript line, so duplicating them here is noise.
		const running = allAgents.filter((a) => a.status === "running" && a.isBackground);
		const queued = allAgents.filter((a) => a.status === "queued");
		const finished = allAgents.filter(
			(a) =>
				a.status !== "running" &&
				a.status !== "queued" &&
				a.completedAt != null &&
				this.shouldShowFinished(a.status, a.completedAt, a.isBackground),
		);

		if (running.length === 0 && queued.length === 0 && finished.length === 0) return [];

		const w = tui.terminal.columns;
		const truncate = (line: string) => truncateToWidth(line, w);
		const hasActive = running.length > 0 || queued.length > 0;
		const headingColor = hasActive ? "accent" : "dim";
		// ○ hollow = incomplete (still running), ● filled disk = complete (all done).
		const headingIcon = hasActive ? "○" : "●";
		const frame = SPINNER[this.widgetFrame % SPINNER.length] ?? "";

		const finishedLines: string[] = [];
		for (const a of finished) {
			finishedLines.push(truncate(`${theme.fg("dim", "├─")} ${this.renderFinishedLine(a, theme)}`));
		}

		const runningLines: string[] = [];
		for (const a of running) {
			const name = getDisplayName(a.type);
			const modeLabel = getPromptModeLabel(a.type);
			// model label inline (the pix twist)
			const modelLabel = a.invocation?.modelName
				? ` ${theme.fg("muted", `[${a.invocation.modelName}]`)}`
				: "";
			const modeTag = modeLabel ? ` ${theme.fg("dim", `(${modeLabel})`)}` : "";
			const elapsed = formatMs(Date.now() - a.startedAt);

			const bg = this.agentActivity.get(a.id);
			const toolUses = bg?.toolUses ?? a.toolUses;
			const contextUsage = bg?.session ? getSessionContextUsage(bg.session as SessionLike) : null;
			// plain=true: uniform dim tail (statsText is wrapped once below).
			const ctxText = formatSessionContext(contextUsage, theme, a.compactionCount, true);

			const parts: string[] = [];
			if (bg && bg.turnCount > 0) parts.push(formatTurns(bg.turnCount, bg.maxTurns));
			if (toolUses > 0) parts.push(formatToolUses(toolUses));
			if (ctxText) parts.push(ctxText);
			const liveSpeed = formatSpeed(bg?.lifetimeUsage.output ?? 0, bg?.streamingMs ?? 0);
			if (liveSpeed) parts.push(liveSpeed);
			parts.push(elapsed);
			const statsText = dotJoin(parts);

			// Activity trails at the end (after stats) so its variable width
			// doesn't cause the static identity + stats to bounce around.
			const activity = bg ? describeActivity(bg.activeTools, bg.responseText) : "thinking…";

			const dot = (s: string) => theme.fg("dim", s);
			runningLines.push(
				truncate(
					theme.fg("dim", "├─") +
						` ${dotJoin([`${theme.fg("accent", frame)} ${theme.fg("toolTitle", theme.bold(name))}${modelLabel}${modeTag}`, theme.fg("muted", a.description), theme.fg("dim", statsText), theme.fg("dim", activity)], dot)}`,
				),
			);
		}

		const queuedLine =
			queued.length > 0
				? truncate(
						theme.fg("dim", "├─") +
							` ${theme.fg("muted", "◦")} ${theme.fg("dim", `${queued.length} queued`)}`,
					)
				: undefined;

		const maxBody = MAX_WIDGET_LINES - 1;
		const totalBody = finishedLines.length + runningLines.length + (queuedLine ? 1 : 0);

		const lines: string[] = [
			truncate(`${theme.fg(headingColor, headingIcon)} ${theme.fg(headingColor, "Agents")}`),
		];

		if (totalBody <= maxBody) {
			lines.push(...finishedLines);
			lines.push(...runningLines);
			if (queuedLine) lines.push(queuedLine);

			// Fix last connector ├─ → └─
			if (lines.length > 1) {
				const last = lines.length - 1;
				lines[last] = (lines[last] ?? "").replace("├─", "└─");
			}
		} else {
			let budget = maxBody - 1;
			let hiddenRunning = 0;
			let hiddenFinished = 0;

			for (const line of runningLines) {
				if (budget >= 1) {
					lines.push(line);
					budget--;
				} else {
					hiddenRunning++;
				}
			}
			if (queuedLine && budget >= 1) {
				lines.push(queuedLine);
				budget--;
			}
			for (const fl of finishedLines) {
				if (budget >= 1) {
					lines.push(fl);
					budget--;
				} else {
					hiddenFinished++;
				}
			}

			const overflowParts: string[] = [];
			if (hiddenRunning > 0) overflowParts.push(`${hiddenRunning} running`);
			if (hiddenFinished > 0) overflowParts.push(`${hiddenFinished} finished`);
			lines.push(
				truncate(
					theme.fg("dim", "└─") +
						` ${theme.fg("dim", `+${hiddenRunning + hiddenFinished} more (${overflowParts.join(", ")})`)}`,
				),
			);
		}

		return lines;
	}

	update() {
		if (!this.uiCtx) return;
		const allAgents = this.manager.listAgents();

		let runningCount = 0;
		let queuedCount = 0;
		let hasFinished = false;
		for (const a of allAgents) {
			// Only count background running agents — foreground ones show
			// progress inline in the transcript, not in the widget.
			if (a.status === "running" && a.isBackground) runningCount++;
			else if (a.status === "queued") queuedCount++;
			else if (
				a.completedAt != null &&
				this.shouldShowFinished(a.status, a.completedAt, a.isBackground)
			)
				hasFinished = true;
		}
		const hasActive = runningCount > 0 || queuedCount > 0;

		if (!hasActive && !hasFinished) {
			if (this.widgetRegistered) {
				this.uiCtx.setWidget("agents", undefined);
				this.widgetRegistered = false;
				this.tui = undefined;
			}
			if (this.lastStatusText !== undefined) {
				this.uiCtx.setStatus("subagents", undefined);
				this.lastStatusText = undefined;
			}
			this.clearTimers();
			return;
		}

		// When only lingering finished agents remain (no active spinner to animate),
		// drop the 80ms polling interval and schedule a one-shot timeout for the
		// earliest linger expiry. This avoids ~12 wasted ticks/s during the 5–15s
		// finished-linger window. ensureTimer() re-arms the fast interval when a
		// new agent starts during the linger window.
		if (!hasActive && hasFinished) {
			if (this.widgetInterval) {
				clearInterval(this.widgetInterval);
				this.widgetInterval = undefined;
			}
			if (!this.lingerTimeout) {
				// Find earliest linger expiry across all finished agents
				let earliest = Number.POSITIVE_INFINITY;
				for (const a of allAgents) {
					if (a.status === "running" || a.status === "queued") continue;
					if (a.completedAt == null || !a.isBackground) continue;
					const linger = ERROR_STATUSES.has(a.status)
						? AgentWidget.ERROR_LINGER_MS
						: AgentWidget.FINISHED_LINGER_MS;
					const expiry = a.completedAt + linger;
					if (expiry < earliest) earliest = expiry;
				}
				const delay = Math.max(50, earliest - Date.now() + 50); // +50ms epsilon
				this.lingerTimeout = setTimeout(() => {
					this.lingerTimeout = undefined;
					this.update();
				}, delay);
			}
		}

		let newStatusText: string | undefined;
		if (hasActive) {
			const r = runningCount > 0 ? `${runningCount}` : "";
			const q = queuedCount > 0 ? `+${queuedCount}` : "";
			newStatusText = `${icon("agent")} ${this.uiCtx.theme.fg("dim", `${r}${q}`)}`;
		}
		if (newStatusText !== this.lastStatusText) {
			this.uiCtx.setStatus("subagents", newStatusText);
			this.lastStatusText = newStatusText;
		}

		this.widgetFrame++;

		if (!this.widgetRegistered) {
			this.uiCtx.setWidget(
				"agents",
				(tui, theme) => {
					this.tui = tui;
					return {
						render: () =>
							this.renderWidget(
								tui as {
									terminal: { columns: number };
									requestRender?: () => void;
								},
								theme,
							),
						invalidate: () => {
							this.widgetRegistered = false;
							this.tui = undefined;
						},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.widgetRegistered = true;
		} else {
			(this.tui as { requestRender?: () => void } | undefined)?.requestRender?.();
		}
	}

	private clearTimers() {
		if (this.widgetInterval) {
			clearInterval(this.widgetInterval);
			this.widgetInterval = undefined;
		}
		if (this.lingerTimeout) {
			clearTimeout(this.lingerTimeout);
			this.lingerTimeout = undefined;
		}
	}

	dispose() {
		this.clearTimers();
		if (this.uiCtx) {
			this.uiCtx.setWidget("agents", undefined);
			this.uiCtx.setStatus("subagents", undefined);
		}
		this.widgetRegistered = false;
		this.tui = undefined;
		this.lastStatusText = undefined;
	}
}
