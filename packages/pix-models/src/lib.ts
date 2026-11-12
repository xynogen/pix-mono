/** Pure /model picker logic: formatting, sorting, search. */

import { formatCost } from "@xynogen/pix-data";
import { fuzzyFilter } from "@xynogen/pix-pretty/tui";

export function resolveContextWindow(
	model: { contextWindow?: number | null },
	fallback?: number | null,
): number {
	if (
		typeof model.contextWindow === "number" &&
		Number.isFinite(model.contextWindow) &&
		model.contextWindow > 0
	)
		return model.contextWindow;
	if (typeof fallback === "number" && Number.isFinite(fallback) && fallback > 0) return fallback;
	return 0;
}

export function fmtCtx(n: number): string {
	if (!n || n < 1_000) return `${n}`;
	if (n >= 1_000_000) {
		const m = n / 1_000_000;
		return `${Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1).replace(/\.0$/, "")}M`;
	}
	return `${Math.round(n / 1_000)}k`;
}

/** Table cell: pix-data formatCost, or an em dash when the price is unknown. */
export function fmtCost(entry: { cost?: { input?: number; output?: number } } | undefined): string {
	if (!entry?.cost) return "\u2014";
	return formatCost(entry.cost.input ?? 0, entry.cost.output ?? 0) ?? "\u2014";
}

export function benchStars(score: number | null | undefined): {
	filled: number;
	empty: number;
} {
	const total = 5;
	let filled = 1;
	if (typeof score === "number") {
		if (score >= 90) filled = 5;
		else if (score >= 80) filled = 4;
		else if (score >= 70) filled = 3;
		else if (score >= 50) filled = 2;
	}
	return { filled, empty: total - filled };
}

export type SortableModel = {
	provider: string;
	id: string;
	name?: string;
	score?: number | null;
	/**
	 * Sort tier. Lower = earlier. Default 0.
	 *  0 = scored (sort by `score` desc)
	 *  1 = benched but unscored (sort by name, between scored and off-catalog)
	 *  2 = off-catalog (no bench entry at all → always last)
	 * The off-catalog tier exists for models like `openrouter/owl-alpha` that
	 * are present in the router but missing from every benchmark source —
	 * they should never interleave with the benched-but-unscored tail.
	 */
	tier?: number;
};

export function sortModels<T extends SortableModel>(models: T[]): T[] {
	return [...models].sort((a, b) => {
		const ta = a.tier ?? 0;
		const tb = b.tier ?? 0;
		if (ta !== tb) return ta - tb;
		if (ta === 0) {
			const sa = a.score ?? -1;
			const sb = b.score ?? -1;
			if (sa !== sb) return sb - sa;
		}
		return (a.name ?? a.id).localeCompare(b.name ?? b.id);
	});
}

/** Short protocol tag for a classifier model's api. */
export function classifierProtocol(api: string): string {
	if (api.endsWith("system-one")) return "System One";
	if (api === "llama-cpp-classify") return "llama.cpp classify";
	return api;
}

/** Picker value prefixes for non-chat rows. They cannot be chat models. */
export const CLASSIFIER_VALUE_PREFIX = "classifier:";
export const IMAGE_VALUE_PREFIX = "image:";

/** Picker tabs, one per Pi model type, so each task's models stay separate. */
export const MODEL_TABS = [
	{ id: "chat", label: "Chat", hint: "context · pricing · coding rank & score from modelgrep.com" },
	{ id: "classifier", label: "Classifier", hint: "typed answers · codemode models.classify()" },
	{ id: "image", label: "Image", hint: "image generation · codemode models.generateImages()" },
] as const;

export type ModelTab = (typeof MODEL_TABS)[number]["id"];

/** Lowercase and strip all non-alphanumerics: "glm-5.2" → "glm52". */
export function normalizeModelText(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// ─── Thinking level control ──────────────────────────────────────────────────

/**
 * Step one notch along the levels the active model supports (from pi-ai
 * `getSupportedThinkingLevels`, which reads the model's `thinkingLevelMap`).
 * Clamps at the ends. Unknown input anchors on "medium", else the first level.
 */
export function stepThinkingLevel(levels: readonly string[], current: string, dir: -1 | 1): string {
	const idx = levels.indexOf(current);
	const base = idx >= 0 ? idx : Math.max(0, levels.indexOf("medium"));
	return levels[Math.min(levels.length - 1, Math.max(0, base + dir))] ?? current;
}

export type ModelSearchLookup = {
	/** benchlm local rank per item value (ranked models only). */
	rankByValue: Map<string, number>;
	/** Clean haystack per value: `${id} ${name ?? ""}` (no ANSI, no rank cell). */
	searchTextByValue: Map<string, string>;
	/** normalizeModelText(haystack) per value — for family+version substring matches. */
	normalizedByValue: Map<string, string>;
};

/**
 * Filter+order picker items for a search query.
 *  - "" → all items unchanged.
 *  - digits-only → items whose benchlm rank equals the number, followed by
 *    normalized-substring matches ("52" ⊂ "glm52") rank-sorted.
 *  - otherwise → normalized-substring matches first (rank-sorted), then
 *    fuzzy matches over the clean haystack (rank-sorted, stable), deduped.
 */
export function filterModelItems<T extends { value: string }>(
	items: T[],
	query: string,
	lookup: ModelSearchLookup,
): T[] {
	const q = query.trim();
	if (q.length === 0) return items;

	const rankSort = (arr: T[]): T[] => {
		return arr
			.map((it, i) => ({ it, i }))
			.sort((a, b) => {
				const ra = lookup.rankByValue.get(a.it.value) ?? Infinity;
				const rb = lookup.rankByValue.get(b.it.value) ?? Infinity;
				if (ra !== rb) return ra - rb;
				return a.i - b.i;
			})
			.map(({ it }) => it);
	};

	const nq = normalizeModelText(q);
	const subMatches =
		nq.length > 0
			? items.filter((it) => (lookup.normalizedByValue.get(it.value) ?? "").includes(nq))
			: [];

	if (/^\d+$/.test(q)) {
		const wanted = Number(q);
		const rankMatches = items.filter((it) => lookup.rankByValue.get(it.value) === wanted);
		const rankValues = new Set(rankMatches.map((it) => it.value));
		const extraSub = rankSort(subMatches).filter((it) => !rankValues.has(it.value));
		return [...rankMatches, ...extraSub];
	}

	const fuzzy = fuzzyFilter(items, q, (it) => lookup.searchTextByValue.get(it.value) ?? "");
	const subValues = new Set(subMatches.map((it) => it.value));
	const extraFuzzy = rankSort(fuzzy).filter((it) => !subValues.has(it.value));
	return [...rankSort(subMatches), ...extraFuzzy];
}
