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
	/** Over threshold: newest tool results kept as is; older bash/grep/find/ls/read output is masked. */
	maskKeep: number;
	/** Skip a masking pass that would free fewer tokens than this (each pass breaks the prompt cache). */
	maskMinTokens: number;
}

const MINIMUM_TOKEN_FLOOR = 25_000;
const MINIMUM_TOKEN_DEFAULT = 100_000;

const DEFAULTS: Readonly<CompactionConfig> = {
	triggerPercent: 60,
	minimumTokens: MINIMUM_TOKEN_DEFAULT,
	maskKeep: 10,
	maskMinTokens: 5_000,
};

/** Clamp to [0, 100]; non-numbers fall back. */
function pctOr(v: unknown, fallback: number): number {
	if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
	return Math.min(100, Math.max(0, v));
}

/** Require a finite token floor of at least 25k. */
function minimumTokensOr(v: unknown, fallback: number): number {
	if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
	// Strings from older/hand-edited pix.json (e.g. "150k") → parse before clamping.
	return Math.max(MINIMUM_TOKEN_FLOOR, Math.round(v));
}

/** Non-negative integer; non-numbers fall back. */
function countOr(v: unknown, fallback: number): number {
	if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
	return Math.max(0, Math.round(v));
}

function parseTokenString(label: string): number | undefined {
	const raw = label.trim();
	if (!raw) return undefined;
	const m = raw.match(/^([0-9]*\.?[0-9]+)\s*([km])?$/i);
	if (!m) return undefined;
	const numStr = m[1] ?? "";
	const n = Number.parseFloat(numStr);
	if (!Number.isFinite(n)) return undefined;
	const suf = (m[2] ?? "").toLowerCase();
	if (suf === "m") return Math.round(n * 1_000_000);
	if (suf === "k") return Math.round(n * 1000);
	return Math.round(n);
}

export const compactionSection = defineSection<"compaction", CompactionConfig>({
	key: "compaction",
	defaults: DEFAULTS,
	parse(raw) {
		if (!isObj(raw)) return { ...DEFAULTS };
		const rawMin = raw.minimumTokens;
		const coercedMin =
			typeof rawMin === "string" ? (parseTokenString(rawMin) ?? Number.NaN) : rawMin;
		return {
			triggerPercent: pctOr(raw.triggerPercent, DEFAULTS.triggerPercent),
			minimumTokens: minimumTokensOr(coercedMin, DEFAULTS.minimumTokens),
			maskKeep: countOr(raw.maskKeep, DEFAULTS.maskKeep),
			maskMinTokens: countOr(raw.maskMinTokens, DEFAULTS.maskMinTokens),
		};
	},
});
