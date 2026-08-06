/** usage.ts — Token usage: shapes, accumulator operators, session-stats readers. */

/**
 * Lifetime usage components, accumulated via `message_end` events. Survives
 * compaction (which replaces session.state.messages and would reset any
 * stats-derived sum). cacheRead is excluded because each turn's cacheRead is
 * the cumulative cached prefix re-read on that one call — summing across
 * turns counts the prefix N times. See issue #38.
 */
export type LifetimeUsage = {
	input: number;
	output: number;
	cacheWrite: number;
};

/** Sum of lifetime usage components, or 0 if undefined. */
export function getLifetimeTotal(u?: LifetimeUsage): number {
	return u ? u.input + u.output + u.cacheWrite : 0;
}

/** Add a usage delta into a target accumulator (mutates target). */
export function addUsage(into: LifetimeUsage, delta: LifetimeUsage): void {
	into.input += delta.input;
	into.output += delta.output;
	into.cacheWrite += delta.cacheWrite;
}

// Session-stats shapes + readers now live in @xynogen/pix-pretty/widget-format
// (shared with pix-commands' /btw widget). Re-exported here so existing
// `from "./usage.ts"` imports keep resolving.
export {
	type ContextUsageLike,
	getSessionContextPercent,
	getSessionContextUsage,
	type SessionLike,
	type SessionStatsLike,
} from "@xynogen/pix-pretty/widget-format";
