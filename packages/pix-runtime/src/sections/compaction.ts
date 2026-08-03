import { defineSection, isObj } from "../schema.ts";

/**
 * Custom compaction config. pix-core always replaces pi's built-in compaction
 * summary. When `triggerPercent > 0` it also drives its own trigger from live
 * context usage — firing once usage reaches that percent of the ACTIVE model's
 * context window, so the threshold scales with whatever model you pick. `0`
 * disables the self-trigger (pi decides when to compact).
 */
export interface CompactionConfig {
	/** Context-window usage percent that fires compaction; 0 = off. */
	triggerPercent: number;
}

const DEFAULTS: Readonly<CompactionConfig> = {
	triggerPercent: 60,
};

/** Clamp to [0, 100]; non-numbers fall back. */
function pctOr(v: unknown, fallback: number): number {
	if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
	return Math.min(100, Math.max(0, v));
}

export const compactionSection = defineSection<"compaction", CompactionConfig>({
	key: "compaction",
	defaults: DEFAULTS,
	parse(raw) {
		if (!isObj(raw)) return { ...DEFAULTS };
		return {
			triggerPercent: pctOr(raw.triggerPercent, DEFAULTS.triggerPercent),
		};
	},
});
