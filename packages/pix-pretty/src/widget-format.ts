/**
 * widget-format.ts — pure, shared live-widget formatting helpers.
 *
 * These are the token/context/turn/tool/speed formatters plus the session
 * context-usage readers used by pix-subagent's agent widget and pix-commands'
 * /btw widget. They are pure (no Theme, no Pi host) so both packages can import
 * them from this sanctioned shared layer instead of duplicating the code.
 *
 * icon() is imported locally (this module lives inside pix-pretty).
 */

import { icon } from "./icon-catalog.ts";

// ── Braille spinner ──────────────────────────────────────────────────────────

export const SPINNER = [
	"\u280b",
	"\u2819",
	"\u2839",
	"\u2838",
	"\u283c",
	"\u2834",
	"\u2826",
	"\u2827",
	"\u2807",
	"\u280f",
];

// ── Session-stats shapes + readers ─────────────────────────────────────────────

/** Minimal shape we read from upstream `getSessionStats()`. */
export type SessionStatsLike = {
	tokens: { input: number; output: number; cacheWrite: number };
	contextUsage?: { tokens?: number | null; contextWindow?: number; percent: number | null };
};
export type SessionLike = { getSessionStats(): SessionStatsLike };

/** Context usage snapshot: estimated used tokens, window size, percent. */
export type ContextUsageLike = {
	tokens: number | null;
	contextWindow: number | null;
	percent: number | null;
};

/** Full context usage, or null when unavailable. */
export function getSessionContextUsage(session: SessionLike | undefined): ContextUsageLike | null {
	if (!session) return null;
	try {
		const cu = session.getSessionStats().contextUsage;
		if (!cu) return null;
		return {
			tokens: cu.tokens ?? null,
			contextWindow: cu.contextWindow ?? null,
			percent: cu.percent ?? null,
		};
	} catch {
		return null;
	}
}

/**
 * Context-window utilization (0–100), or null when unavailable
 * (no model contextWindow, or post-compaction before the next response).
 */
export function getSessionContextPercent(session: SessionLike | undefined): number | null {
	return getSessionContextUsage(session)?.percent ?? null;
}

// ── Formatters ─────────────────────────────────────────────────────────────────

export function formatTokens(count: number): string {
	const t = icon("tokens");
	if (count >= 1_000_000) return `${t} ${(count / 1_000_000).toFixed(1)}M token`;
	if (count >= 1_000) return `${t} ${(count / 1_000).toFixed(1)}k token`;
	return `${t} ${count} token`;
}

/** Compact token count: 500 → "500", 30_100 → "30.1K", 1_000_000 → "1.00M". */
export function fmtTokenCount(n: number): string {
	if (n < 1_000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}K`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * Format context-window utilization: "󰉿 30.1K/1.00M (3%)".
 * Falls back to "󰉿 3% ctx" when the window size is unknown.
 * Returns "" when percent is null/unavailable (caller should skip the segment).
 */
export function formatContext(usage: ContextUsageLike | null | undefined): string {
	if (usage?.percent == null) return "";
	const t = icon("tokens");
	const pct = Math.round(usage.percent);
	if (!usage.contextWindow) return `${t} ${pct}% ctx`;
	const used = usage.tokens ?? Math.round((usage.percent / 100) * usage.contextWindow);
	return `${t} ${fmtTokenCount(used)}/${fmtTokenCount(usage.contextWindow)} (${pct}%)`;
}

export function formatTurns(turnCount: number, maxTurns?: number | null): string {
	const t = icon("turns");
	return maxTurns != null ? `${t} ${turnCount}≤${maxTurns}` : `${t} ${turnCount}`;
}

export function formatToolUses(count: number): string {
	return `${icon("tools")} ${count}`;
}

export function formatMs(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Output tokens per second over a duration. "" when either input is
 * non-positive (no work / zero elapsed) so callers can skip the segment.
 */
export function formatSpeed(outputTokens: number, durationMs: number): string {
	if (outputTokens <= 0 || durationMs <= 0) return "";
	return `${Math.round(outputTokens / (durationMs / 1000))} t/s`;
}

// ── Activity description ─────────────────────────────────────────────────────

export const TOOL_DISPLAY: Record<string, string> = {
	read: "reading",
	bash: "running command",
	edit: "editing",
	write: "writing",
	grep: "searching",
	find: "finding files",
	ls: "listing",
};

/**
 * Live tail of agent output: latest non-empty line, tail-anchored to `len`
 * chars (keeps the moving edge, not the stale first line).
 */
export function truncateLine(text: string, len = 32): string {
	const lines = text.split("\n").filter((l) => l.trim());
	const line = (lines.at(-1) ?? "").trim();
	if (line.length <= len) return line;
	return `\u2026${line.slice(-len)}`;
}

/**
 * One-line description of what an agent/job is doing: grouped active tools,
 * else a tail (`tailLen` chars, default 32) of the streaming answer text, else
 * "thinking…".
 */
export function describeActivity(
	activeTools: Map<string, string>,
	responseText?: string,
	tailLen = 32,
): string {
	if (activeTools.size > 0) {
		const groups = new Map<string, number>();
		for (const toolName of activeTools.values()) {
			const action = TOOL_DISPLAY[toolName] ?? toolName;
			groups.set(action, (groups.get(action) ?? 0) + 1);
		}
		const parts: string[] = [];
		for (const [action, count] of groups) {
			parts.push(count > 1 ? `${action} ${count}\u00d7` : action);
		}
		return `${parts.join(", ")}\u2026`;
	}
	if (responseText?.trim()) return truncateLine(responseText, tailLen);
	return "thinking\u2026";
}
