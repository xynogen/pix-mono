import { defineSection, isObj } from "../schema.ts";

/**
 * Custom compaction config. pix-core always replaces pi's built-in compaction
 * summary. When `triggerPercent > 0` it also drives its own trigger from live
 * context usage. The effective threshold is the larger of that percentage of
 * the active model's context window and `minimumTokens`. `0` disables the
 * self-trigger (pi decides when to compact).
 */
export interface CompactionConfig {
	/** Context-window usage percent that fires compaction; 0 = off. */
	triggerPercent: number;
	/** Absolute floor for a percentage-based trigger. */
	minimumTokens: number;
}

const MINIMUM_TOKEN_FLOOR = 25_000;
const MINIMUM_TOKEN_DEFAULT = 100_000;

const DEFAULTS: Readonly<CompactionConfig> = {
	triggerPercent: 60,
	minimumTokens: MINIMUM_TOKEN_DEFAULT,
};

/** Clamp to [0, 100]; non-numbers fall back. */
function pctOr(v: unknown, fallback: number): number {
	if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
	return Math.min(100, Math.max(0, v));
}

/** Require a finite token floor of at least 25k. */
function minimumTokensOr(v: unknown, fallback: number): number {
	if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
	return Math.max(MINIMUM_TOKEN_FLOOR, Math.round(v));
}

export const compactionSection = defineSection<"compaction", CompactionConfig>({
	key: "compaction",
	defaults: DEFAULTS,
	parse(raw) {
		if (!isObj(raw)) return { ...DEFAULTS };
		return {
			triggerPercent: pctOr(raw.triggerPercent, DEFAULTS.triggerPercent),
			minimumTokens: minimumTokensOr(raw.minimumTokens, DEFAULTS.minimumTokens),
		};
	},
});
