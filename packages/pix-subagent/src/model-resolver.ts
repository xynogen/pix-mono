/**
 * Model resolution: exact match ("provider/modelId") with fuzzy fallback.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { lookupBenchmark, lookupModelsDev } from "@xynogen/pix-data";
import { dotJoin } from "@xynogen/pix-pretty/utils";

export interface ModelEntry {
	id: string;
	name: string;
	provider: string;
}

export interface ModelRegistry {
	find(provider: string, modelId: string): Model<Api> | undefined;
	getAll(): Model<Api>[];
	getAvailable?(): Model<Api>[];
}

/**
 * Resolve a model string to a Model instance.
 * Tries exact match first ("provider/modelId"), then fuzzy match against all available models.
 * Returns the Model on success, or an error message string on failure.
 */
export function resolveModel(input: string, registry: ModelRegistry): Model<Api> | string {
	// Available models (those with auth configured)
	const all = (registry.getAvailable?.() ?? registry.getAll()) as ModelEntry[];
	const availableSet = new Set(all.map((m) => `${m.provider}/${m.id}`.toLowerCase()));

	// 1. Exact match: "provider/modelId" — only if available (has auth)
	const slashIdx = input.indexOf("/");
	if (slashIdx !== -1) {
		const provider = input.slice(0, slashIdx);
		const modelId = input.slice(slashIdx + 1);
		if (availableSet.has(input.toLowerCase())) {
			const found = registry.find(provider, modelId);
			if (found) return found;
		}
	}

	// 2. Fuzzy match against available models
	const query = input.toLowerCase();

	// Score each model: prefer exact id match > id contains > name contains > provider+id contains
	let bestMatch: ModelEntry | undefined;
	let bestScore = 0;

	for (const m of all) {
		const id = m.id.toLowerCase();
		const name = m.name.toLowerCase();
		const full = `${m.provider}/${m.id}`.toLowerCase();

		let score = 0;
		if (id === query || full === query) {
			score = 100; // exact
		} else if (id.includes(query) || full.includes(query)) {
			score = 60 + (query.length / id.length) * 30; // substring, prefer tighter matches
		} else if (name.includes(query)) {
			score = 40 + (query.length / name.length) * 20;
		} else if (
			query
				.split(/[\s\-/]+/)
				.every(
					(part) =>
						id.includes(part) || name.includes(part) || m.provider.toLowerCase().includes(part),
				)
		) {
			score = 20; // all parts present somewhere
		}

		if (score > bestScore) {
			bestScore = score;
			bestMatch = m;
		}
	}

	if (bestMatch && bestScore >= 20) {
		const found = registry.find(bestMatch.provider, bestMatch.id);
		if (found) return found;
	}

	// 3. No match — list available models
	const modelList = all
		.map((m) => `  ${m.provider}/${m.id}`)
		.sort()
		.join("\n");
	return `Model not found: "${input}".\n\nAvailable models:\n${modelList}`;
}

// ── Enrichment for orchestrator model choice ────────────────────────────────
// The orchestrator picks a worker model from the `agent` tool description. Bare
// ids carry no signal, so each line is annotated with bench score, context,
// price, and a coarse tier — sourced from pix-data (the shared data layer).

// Tiers cut on coding_pct (0-100 percentile within modelgrep's benched set).
const SCORE_FRONTIER = 88; // ~top 12% coder
const SCORE_STRONG = 75; // ~top 25% coder
const CHEAP_OUTPUT_PRICE = 3; // $/M output tokens — below this counts as cheap

/** Context window → compact "200k" / "1M". */
function fmtCtx(n: number | undefined): string {
	if (!n || n < 1_000) return n ? `${n}` : "";
	if (n >= 1_000_000) {
		const m = n / 1_000_000;
		return `${Number.isInteger(m) ? m : m.toFixed(1).replace(/\.0$/, "")}M ctx`;
	}
	return `${Math.round(n / 1_000)}k ctx`;
}

/** Cost → "$3/$15" (input/output per Mtok), "free", or "" when unknown. */
function fmtCost(input?: number, output?: number): string {
	if (input == null && output == null) return "";
	const i = input ?? 0;
	const o = output ?? 0;
	if (i === 0 && o === 0) return "free";
	return `$${i}/$${o}`;
}

/** Coarse decision tier from score + output price. */
function tier(score: number | null | undefined, output?: number): string {
	if (typeof score !== "number") return "";
	if (score >= SCORE_FRONTIER) return "frontier";
	if (score >= SCORE_STRONG) return "strong";
	if (output != null && output <= CHEAP_OUTPUT_PRICE) return "fast-cheap";
	return "basic";
}

/** One enriched line: "provider/id  — ⚡95 · 200k ctx · $3/$15 · frontier". */
function annotate(m: ModelEntry): { line: string; score: number } {
	const dev = lookupModelsDev(m.provider, m.id);
	const bench = lookupBenchmark(m.id);
	const score = bench?.overallScore ?? null;
	const out = bench?.outputPrice ?? dev?.cost?.output;
	const segs = dotJoin([
		typeof score === "number" && `⚡${score}`,
		fmtCtx(dev?.limit?.context),
		fmtCost(bench?.inputPrice ?? dev?.cost?.input, out),
		tier(score, out),
	]);
	const id = `${m.provider}/${m.id}`;
	return {
		line: segs ? `${id}  — ${segs}` : id,
		score: score ?? -1,
	};
}

/**
 * List available models, enriched + ranked for orchestrator decisions.
 * Sorted by bench score desc (best first); unscored fall to the bottom
 * alphabetically (preserved by the stable id tiebreak).
 */
export function listAvailable(registry: ModelRegistry): string[] {
	const all = (registry.getAvailable?.() ?? registry.getAll()) as ModelEntry[];
	return all
		.map((m) => ({ ...annotate(m), id: `${m.provider}/${m.id}` }))
		.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
		.map((r) => r.line);
}
