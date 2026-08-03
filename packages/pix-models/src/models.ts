/**
 * models.ts — enhanced /models command with benchlm rank + score
 *
 * Replaces (or supplements) the built-in /model selector by registering
 * /models (plural). Each row shows:
 *   <name>  <provider> · <ctx> · <cost> · 🏅 #rank score
 *
 * Sorted by benchlm rank when available (best first), then alphabetical.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	fuzzyFilter,
	Input,
	Key,
	matchesKey,
	type SelectItem,
	SelectList,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { benchScoreColor, lookupBenchmark, lookupModelsDev } from "@xynogen/pix-data";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import {
	frameModal,
	MIN_MODAL_HEIGHT,
	ModalPager,
	modalWidth,
	terminalModalHeight,
} from "@xynogen/pix-pretty/modal-frame";
import { patchOutBuiltinModelCommand } from "./patch-builtin";

// ─── Pure logic (exported for tests) ─────────────────────────────────────────

export function fmtCtx(n: number): string {
	if (!n || n < 1_000) return `${n}`;
	if (n >= 1_000_000) {
		const m = n / 1_000_000;
		return `${Number.isInteger(m) ? m.toFixed(0) : m.toFixed(1).replace(/\.0$/, "")}M`;
	}
	return `${Math.round(n / 1_000)}k`;
}

export function fmtCost(entry: { cost?: { input?: number; output?: number } } | undefined): string {
	if (!entry?.cost) return "\u2014";
	const i = entry.cost.input ?? 0;
	const o = entry.cost.output ?? 0;
	if (i === 0 && o === 0) return "free";
	return `${i.toFixed(2)}/${o.toFixed(2)}`;
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

/** Lowercase and strip all non-alphanumerics: "glm-5.2" → "glm52". */
export function normalizeModelText(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// ─── Thinking level control ──────────────────────────────────────────────────

/**
 * Canonical thinking levels, ascending. ←/→ in the picker steps through this list;
 * pi.setThinkingLevel() clamps to what the active model actually supports,
 * so visiting an unsupported rung is harmless (it lands on the nearest allowed).
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

/**
 * Step the thinking level one notch. `dir` is -1 (←) or +1 (→). Clamps at the
 * ends (no wraparound) so ← at "off" stays "off" and → at "xhigh" stays "xhigh".
 * Unknown input falls back to "medium" as a neutral midpoint.
 */
export function stepThinkingLevel(current: string, dir: -1 | 1): ThinkingLevelName {
	const idx = THINKING_LEVELS.indexOf(current as ThinkingLevelName);
	const base = idx === -1 ? THINKING_LEVELS.indexOf("medium") : idx;
	const next = Math.min(THINKING_LEVELS.length - 1, Math.max(0, base + dir));
	return THINKING_LEVELS[next] as ThinkingLevelName;
}

/**
 * Move one effective notch in a direction after the host clamps unsupported
 * levels. Keeps trying farther rungs until the model's resolved level changes.
 */
export function stepEffectiveThinkingLevel(
	current: string,
	dir: -1 | 1,
	apply: (level: ThinkingLevelName) => string,
): ThinkingLevelName {
	let candidate = stepThinkingLevel(current, dir);
	while (candidate !== current) {
		const effective = apply(candidate) as ThinkingLevelName;
		if (effective !== current) return effective;
		const farther = stepThinkingLevel(candidate, dir);
		if (farther === candidate) break;
		candidate = farther;
	}
	return current as ThinkingLevelName;
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

async function showEnhancedPicker(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	// Mirror the built-in /model selector, which calls refresh() then awaits
	// getAvailable() (see model-selector.js). Without refresh(), this extension
	// reads whatever `this.models` was last loaded into — which, depending on
	// extension load order vs oauth/auth resolution, can omit oauth providers
	// whose models were registered as built-ins but resolved after the last
	// load (notably `openai-codex`). 9router survives because it's registered
	// as a custom provider with an env-key apiKey. refresh() rebuilds the model
	// list (resetOAuthProviders → loadModels → re-apply registered providers)
	// so oauth-backed codex models reappear, exactly as the built-in does.
	//
	// The public ExtensionContext type narrows modelRegistry to a sync
	// getAvailable() only; at runtime ctx.modelRegistry is the full
	// ModelRegistry instance (verified in runner.js) with refresh() and an
	// async-capable getAvailable(). Reach through the narrowed type.
	type AvailableModels = ReturnType<typeof ctx.modelRegistry.getAvailable>;
	const registry = ctx.modelRegistry as unknown as {
		refresh?: () => void;
		getAvailable(): AvailableModels | Promise<AvailableModels>;
	};
	registry.refresh?.();
	const available = await registry.getAvailable();
	if (available.length === 0) {
		ctx.ui.notify("No models with configured auth.", "warning");
		return;
	}

	const current = ctx.model;

	// Build items with benchmark data
	type Row = {
		m: (typeof available)[number];
		dev: ReturnType<typeof lookupModelsDev>;
		bench: ReturnType<typeof lookupBenchmark>;
		// Rank among the user's *available* models, not the global catalog.
		localRank: number | null;
		// Sort tier: 0 scored, 1 benched-but-unscored, 2 off-catalog.
		tier: 0 | 1 | 2;
	};
	const rows: Row[] = available.map((m) => {
		const bench = lookupBenchmark(m.id);
		const tier = !bench
			? 2 // off-catalog → absolute bottom (no rank)
			: bench.overallScore == null
				? 1 // benched, unscored → middle
				: 0; // scored → top
		return {
			m,
			dev: lookupModelsDev(m.provider, m.id),
			bench,
			localRank: null,
			tier,
		};
	});

	// Mirror sortModels() — score-desc within tier 0, name-asc otherwise.
	rows.sort((a, b) => {
		const ta = a.tier;
		const tb = b.tier;
		if (ta !== tb) return ta - tb;
		if (ta === 0) {
			const sa = a.bench?.overallScore ?? -1;
			const sb = b.bench?.overallScore ?? -1;
			if (sa !== sb) return sb - sa;
		}
		return (a.m.name ?? a.m.id).localeCompare(b.m.name ?? b.m.id);
	});

	// Local rank = position among scored available models (best pickable = #1).
	let localRank = 0;
	for (const r of rows) if (r.bench) r.localRank = ++localRank;

	// Show all models (no deduplication)
	const dedupedRows = rows;

	// items built inside the custom() factory so we have theme access for colors

	const result = await ctx.ui.custom<string | null>(
		(tui, theme, _kb, done) => {
			const accent = "accent";

			// Find max rank width across all benchmarked rows for # padding
			const maxRankWidth = Math.max(
				...dedupedRows.map((r) => (r.localRank ? String(r.localRank).length : 0)),
				1,
			);

			// Widest cost string so the cost column pads to a common width and the
			// following ⚡score/stars stay column-aligned (e.g. "10.00/50.00" is 11
			// chars — a fixed pad of 10 shifted those rows right by one).
			const maxCostWidth = Math.max(
				...dedupedRows.map((r) => fmtCost(r.dev).length),
				"free".length,
			);

			// Mute low-info parts (separators, padding, #, ☆) so the actual values pop.
			const mute = (s: string) => theme.fg("muted", s);
			const sep = mute(" · ");
			const guide = (key: string, action: string) =>
				theme.fg("text", key) + theme.fg("dim", ` ${action}`);
			const guideSep = theme.fg("dim", " · ");

			// Track rank per item value so fuzzy results can prioritize ranked models.
			const rankByValue = new Map<string, number>();
			for (const { m, localRank } of dedupedRows) {
				if (localRank) rankByValue.set(`${m.provider}/${m.id}`, localRank);
			}

			// Clean search haystacks — labels are ANSI-laden and carry the rank cell,
			// so matching runs against raw id+name instead (see filterModelItems).
			const searchTextByValue = new Map<string, string>();
			const normalizedByValue = new Map<string, string>();
			for (const { m } of dedupedRows) {
				const value = `${m.provider}/${m.id}`;
				const text = `${m.id} ${m.name ?? ""}`;
				searchTextByValue.set(value, text);
				normalizedByValue.set(value, normalizeModelText(text));
			}

			const items: SelectItem[] = dedupedRows.map(({ m, dev, bench, localRank }) => {
				const isCurrent = current && m.provider === current.provider && m.id === current.id;

				// Label: marker + rank cell + accent-colored model name.
				// Ranked models show muted '#' + colored rank. Unranked (no
				// modelgrep entry) show a muted em-dash sized to the rank
				// column, so the model name aligns across rows.
				const marker = isCurrent ? theme.fg(accent, "▶") : " ";
				let rankPrefix: string;
				if (localRank) {
					const rankStr = String(localRank).padEnd(maxRankWidth);
					// Color rank by the model's bench score (same scale as ⚡score),
					// not by list position — keeps the two colors consistent.
					const rankColor = benchScoreColor(bench?.overallScore);
					rankPrefix = mute("#") + theme.fg(rankColor, rankStr);
				} else {
					// Width = "#" + maxRankWidth chars (e.g. "#   " or "#——" for 2-digit ranks).
					const dash = "—".padEnd(maxRankWidth, " ");
					rankPrefix = mute("#") + mute(dash);
				}
				// Display model id only; m.provider is routing provider, not part of id.
				// Color the name by bench score so high-scoring models visually pop.
				const nameColor = bench ? benchScoreColor(bench.overallScore) : accent;
				const idColored = theme.fg(nameColor, m.id);
				const label = `${marker} ${rankPrefix} ${idColored}`;

				// Description: ctx · cost · score stars
				// Colors: ctx muted · cost success (free muted) · score+stars warning
				const ctxRaw = fmtCtx(dev?.limit?.context ?? 0);
				const ctxStr = mute(ctxRaw.padStart(4));
				const rawCost = fmtCost(dev);
				let costSeg: string;
				if (rawCost === "—") {
					costSeg = theme.fg("dim", "—".padEnd(maxCostWidth));
				} else if (rawCost === "free") {
					costSeg = mute("free".padEnd(maxCostWidth));
				} else {
					costSeg = theme.fg("success", rawCost.padEnd(maxCostWidth));
				}
				let benchSeg = "";
				if (bench) {
					const score = bench.overallScore ?? "?";
					const s = bench.overallScore;
					const scoreColor = benchScoreColor(s);
					let filled = 1;
					if (typeof s === "number") {
						if (s >= 90) filled = 5;
						else if (s >= 80) filled = 4;
						else if (s >= 70) filled = 3;
						else if (s >= 50) filled = 2;
					}
					const starBar = theme.fg(scoreColor, "★".repeat(filled)) + mute("☆".repeat(5 - filled));
					benchSeg = `⚡${theme.fg(scoreColor, String(score))} ${starBar}`;
				}
				const desc = [ctxStr, costSeg, benchSeg].filter(Boolean).join(sep);

				return {
					value: `${m.provider}/${m.id}`,
					label,
					description: desc,
				};
			});

			const currentIdx = current
				? items.findIndex((it) => it.value === `${current.provider}/${current.id}`)
				: 0;

			// Widest label (visible width, ANSI-stripped) so the model name
			// column never truncates to "…". Add gap headroom.
			const widestLabel = items.reduce((w, it) => Math.max(w, visibleWidth(it.label)), 0);

			const search = new Input();
			const list = new SelectList(
				items,
				Math.max(1, items.length),
				{
					selectedPrefix: (t) => theme.fg(accent, t),
					selectedText: (t) => theme.fg(accent, t),
					description: (t) => t, // raw — per-segment colors set in items.map
					scrollInfo: (t) => theme.fg("dim", t),
					noMatch: (t) => theme.fg("warning", t),
				},
				{
					minPrimaryColumnWidth: widestLabel + 2,
					maxPrimaryColumnWidth: widestLabel + 2,
				},
			);
			if (currentIdx >= 0) list.setSelectedIndex(currentIdx);

			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(null);
			search.onEscape = () => done(null);

			const applyFuzzy = (query: string) => {
				const internal = list as unknown as {
					items: SelectItem[];
					filteredItems: SelectItem[];
					selectedIndex: number;
					invalidate(): void;
				};
				const next = filterModelItems(internal.items, query, {
					rankByValue,
					searchTextByValue,
					normalizedByValue,
				});
				internal.filteredItems = next;
				internal.selectedIndex = 0;
				internal.invalidate();
			};

			// Live thinking-level readout. ←/→ mutates the session immediately via
			// pi.setThinkingLevel(); we mirror pi.getThinkingLevel() so the header
			// reflects the clamped result (model may not support every rung).
			//
			// `local` shadows the level so the header updates even on builds/contexts
			// where pi.getThinkingLevel() lags or is unavailable inside the overlay.
			// We seed it from the getter, then advance it in lock-step with each
			// setThinkingLevel() call and reconcile back to the getter when present.
			let localLevel = pi.getThinkingLevel?.() ?? "";
			const pager = new ModalPager();
			const thinkLine = () => {
				const live = pi.getThinkingLevel?.();
				const resolved = live ?? localLevel;
				const label = resolved || "—";
				const coloredLabel = resolved
					? theme.getThinkingBorderColor(resolved)(label)
					: theme.fg("dim", label);
				return (
					theme.fg("muted", "Thinking: ") +
					coloredLabel +
					theme.fg("dim", "  (") +
					guide("←/→", "adjust") +
					theme.fg("dim", ")")
				);
			};

			return {
				render(w: number) {
					const mw = modalWidth(w);
					const inner = mw - 4; // CHROME = 2 border + 2 padding
					const result = frameModal({
						width: mw,
						maxHeight: terminalModalHeight(tui.terminal.rows),
						minHeight: MIN_MODAL_HEIGHT,
						header: [
							theme.fg(accent, theme.bold(`${icon("picker.model")}  Select model`)),
							theme.fg("dim", "context · pricing · coding rank & score from modelgrep.com"),
							thinkLine(),
							...search.render(inner),
							"",
						],
						body: list.render(inner),
						selectedBodyRange: (() => {
							const internal = list as unknown as { selectedIndex: number };
							return pager.selectedRange({
								start: internal.selectedIndex,
								end: internal.selectedIndex + 1,
							});
						})(),
						footer: [
							"",
							guide("↑↓", "navigate") +
								guideSep +
								guide("←/→", "thinking") +
								guideSep +
								guide("enter", "select") +
								guideSep +
								guide("esc", "cancel"),
						],
						bodyOffset: pager.bodyOffset,
						color: (s) => theme.fg(accent, s),
						bg: (s) => theme.bg("customMessageBg", s),
						fg: (s) => theme.fg("text", s),
					});
					pager.sync(result);
					return result.lines;
				},
				invalidate() {
					list.invalidate();
					search.invalidate();
				},
				handleInput(data: string) {
					// Detect keys via pi-tui's own parser — the same recognition
					// SelectList uses. Arrows arrive as named keys ("up"/"down"),
					// not raw escape sequences, so string-equality checks fail.
					const isNav = matchesKey(data, "up") || matchesKey(data, "down");
					// ←/→ tunes the ACTIVE session model's thinking level. setThinkingLevel
					// clamps to model capability, so unsupported rungs land on the nearest allowed.
					let dir: -1 | 1 | 0 = 0;
					if (matchesKey(data, Key.left)) dir = -1;
					else if (matchesKey(data, Key.right)) dir = 1;
					if (dir !== 0) {
						const cur = pi.getThinkingLevel?.() || localLevel || "medium";
						localLevel = stepEffectiveThinkingLevel(cur, dir, (candidate) => {
							pi.setThinkingLevel(candidate);
							return pi.getThinkingLevel();
						});
						// setThinkingLevel doesn't repaint this overlay, so force a render
						// now — otherwise the header shows a stale level until the next key.
						tui.requestRender();
						return;
					} else if (isNav || matchesKey(data, "enter")) {
						list.handleInput?.(data);
						if (isNav) pager.followSelection();
					} else if (matchesKey(data, "escape")) {
						done(null);
					} else {
						search.handleInput?.(data);
						applyFuzzy(search.getValue?.() ?? "");
						pager.followSelection();
					}
					list.invalidate();
				},
			};
		},
		{ overlay: true, overlayOptions: { maxHeight: "80%" } },
	);

	if (!result) return;

	// Apply selection
	const [provider, ...rest] = result.split("/");
	const id = rest.join("/");
	const picked = available.find((m) => m.provider === provider && m.id === id);
	if (!picked) {
		ctx.ui.notify(`Model not found: ${result}`, "error");
		return;
	}
	const ok = await pi.setModel(picked);
	if (ok) ctx.ui.notify(`Switched to ${picked.name ?? picked.id}`, "info");
	else ctx.ui.notify(`Failed to switch to ${picked.id}`, "error");
}

export default function modelPickerExtension(pi: ExtensionAPI) {
	// Remove Pi's built-in /model so only the enhanced /models picker remains.
	// Self-healing: re-applies on every load, so a Pi upgrade can't restore it.
	patchOutBuiltinModelCommand();

	const handler = async (_args: unknown, ctx: ExtensionContext) => {
		await showEnhancedPicker(pi, ctx);
	};
	pi.registerCommand("models", {
		description: "Enhanced model picker — shows benchlm rank + score",
		handler,
	});
}
