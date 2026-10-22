/**
 * models.ts — enhanced /models command with benchlm rank + score
 *
 * Replaces (or supplements) the built-in /model selector by registering
 * /models (plural). Each row shows:
 *   <name>  <provider> · <ctx> · <cost> · 🏅 #rank score
 *
 * Sorted by benchlm rank when available (best first), then alphabetical.
 */

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
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
import { benchScoreColor, formatCost, lookupBenchmark, lookupModelsDev } from "@xynogen/pix-data";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import {
	frameModal,
	MIN_MODAL_HEIGHT,
	ModalPager,
	modalOverlayOptions,
	modalWidth,
	terminalModalHeight,
} from "@xynogen/pix-pretty/modal-frame";
import { dotJoin } from "@xynogen/pix-pretty/utils";
import { SPINNER } from "@xynogen/pix-pretty/widget-format";
import { patchOutBuiltinModelCommand } from "./patch-builtin";
import { registerProjectPrefs } from "./project-prefs";

// ─── Pure logic (exported for tests) ─────────────────────────────────────────

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
	type TypedModel = {
		provider: string;
		id: string;
		name?: string;
		api: string;
		contextWindow?: number;
	};
	// SAFETY: Runtime ModelRegistry includes refresh and async availability missing from public types.
	const registry = ctx.modelRegistry as unknown as {
		refresh?: () => void;
		getAvailable(): AvailableModels | Promise<AvailableModels>;
		getAvailableOfType?: (type: "classifier" | "image") => Promise<readonly TypedModel[]>;
	};
	// Classifier and image models are not chat models. Each gets its own tab so
	// they are visible but never picked as the session model.
	const loadOfType = async (type: "classifier" | "image") =>
		(await registry.getAvailableOfType?.(type).catch(() => [])) ?? [];
	const loadTyped = () => Promise.all([loadOfType("classifier"), loadOfType("image")]);
	registry.refresh?.();
	let available = await registry.getAvailable();
	let [classifiers, images] = await loadTyped();
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
	const buildRows = (models: Awaited<AvailableModels>): Row[] => {
		const rows: Row[] = models.map((m) => {
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
			} satisfies Row;
		});

		// Mirror sortModels() — score-desc within tier 0, name-asc otherwise.
		rows.sort((a, b) => {
			if (a.tier !== b.tier) return a.tier - b.tier;
			if (a.tier === 0) {
				const sa = a.bench?.overallScore ?? -1;
				const sb = b.bench?.overallScore ?? -1;
				if (sa !== sb) return sb - sa;
			}
			return (a.m.name ?? a.m.id).localeCompare(b.m.name ?? b.m.id);
		});

		// Local rank = position among scored available models (best pickable = #1).
		let localRank = 0;
		for (const row of rows) if (row.bench) row.localRank = ++localRank;
		return rows;
	};

	// items built inside the custom() factory so we have theme access for colors

	const result = await ctx.ui.custom<string | null>(
		(tui, theme, _kb, done) => {
			const accent = "accent";
			const mute = (s: string) => theme.fg("muted", s);
			const guide = (key: string, action: string) =>
				theme.fg("text", key) + theme.fg("muted", ` ${action}`);
			const guideSep = theme.fg("muted", " · ");

			let tab: ModelTab = "chat";
			const currentValue = current ? `${current.provider}/${current.id}` : undefined;

			const buildPickerData = (forTab: ModelTab) => {
				const entries =
					forTab === "chat"
						? buildRows(available).map(({ m, dev, bench, localRank }) => ({
								m,
								dev,
								bench,
								rank: localRank,
								value: `${m.provider}/${m.id}`,
								text: `${m.id} ${m.name ?? ""}`,
								tag: "",
							}))
						: (forTab === "classifier" ? classifiers : images).map((m, i) => {
								const tag = forTab === "classifier" ? classifierProtocol(m.api) : "";
								const prefix =
									forTab === "classifier" ? CLASSIFIER_VALUE_PREFIX : IMAGE_VALUE_PREFIX;
								return {
									m,
									dev: lookupModelsDev(m.provider, m.id),
									bench: lookupBenchmark(m.id),
									// Non-chat models have no benchmark rank; number them in list order.
									rank: i + 1,
									value: `${prefix}${m.provider}/${m.id}`,
									text: `${m.id} ${m.name ?? ""} ${tag}`,
									tag,
								};
							});
				const maxRankWidth = Math.max(1, ...entries.map((e) => String(e.rank ?? "").length));
				const maxCostWidth = Math.max("free".length, ...entries.map((e) => fmtCost(e.dev).length));
				const rankByValue = new Map<string, number>();
				const searchTextByValue = new Map<string, string>();
				const normalizedByValue = new Map<string, string>();

				const items: SelectItem[] = entries.map(({ m, dev, bench, rank, value, text, tag }) => {
					if (rank) rankByValue.set(value, rank);
					searchTextByValue.set(value, text);
					normalizedByValue.set(value, normalizeModelText(text));
					const rankCell = !rank
						? mute("—".padEnd(maxRankWidth))
						: forTab === "chat"
							? theme.fg(benchScoreColor(bench?.overallScore), String(rank).padEnd(maxRankWidth))
							: mute(String(rank).padEnd(maxRankWidth));
					const marker = value === currentValue ? theme.fg(accent, "▶") : " ";
					const nameColor = bench ? benchScoreColor(bench.overallScore) : accent;
					const label = `${marker} ${mute("#")}${rankCell} ${theme.fg(nameColor, m.id)}`;
					const ctxRaw = fmtCtx(resolveContextWindow(m, dev?.limit?.context));
					const rawCost = fmtCost(dev);
					const costSeg =
						rawCost === "—"
							? theme.fg("muted", "—".padEnd(maxCostWidth))
							: rawCost === "free"
								? mute("free".padEnd(maxCostWidth))
								: theme.fg("success", rawCost.padEnd(maxCostWidth));
					let benchSeg = "";
					if (bench) {
						const score = bench.overallScore ?? "?";
						const scoreColor = benchScoreColor(bench.overallScore);
						const { filled, empty } = benchStars(bench.overallScore);
						const stars = theme.fg(scoreColor, "★".repeat(filled)) + mute("☆".repeat(empty));
						benchSeg = `⚡${theme.fg(scoreColor, String(score))} ${stars}`;
					}
					return {
						value,
						label,
						description: dotJoin(
							[
								mute(ctxRaw.padStart(4)),
								costSeg,
								[benchSeg, tag && mute(tag)].filter(Boolean).join(" "),
							],
							mute,
						),
					};
				});
				return {
					items,
					rankByValue,
					searchTextByValue,
					normalizedByValue,
					widestLabel: items.reduce((width, item) => Math.max(width, visibleWidth(item.label)), 0),
				};
			};

			let pickerData = buildPickerData(tab);
			const currentIdx = currentValue
				? pickerData.items.findIndex((item) => item.value === currentValue)
				: 0;
			const search = new Input();
			const list = new SelectList(
				pickerData.items,
				Math.max(1, pickerData.items.length),
				{
					selectedPrefix: (text) => theme.fg(accent, text),
					selectedText: (text) => theme.fg(accent, text),
					description: (text) => text,
					scrollInfo: (text) => theme.fg("muted", text),
					noMatch: (text) => theme.fg("warning", text),
				},
				{
					minPrimaryColumnWidth: pickerData.widestLabel + 2,
					maxPrimaryColumnWidth: pickerData.widestLabel + 2,
				},
			);
			if (currentIdx >= 0) list.setSelectedIndex(currentIdx);
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(null);
			search.onEscape = () => done(null);

			type ListInternal = {
				items: SelectItem[];
				filteredItems: SelectItem[];
				selectedIndex: number;
				maxVisible: number;
				layout: { minPrimaryColumnWidth: number; maxPrimaryColumnWidth: number };
				invalidate(): void;
			};
			// SAFETY: SelectList has no public item-replacement API; runtime fields are stable and
			// already used above for custom filtering. Keep this cast local to picker updates.
			const listInternal = list as unknown as ListInternal;
			const applyFuzzy = (query: string, selectedValue?: string) => {
				listInternal.filteredItems = filterModelItems(listInternal.items, query, pickerData);
				const selectedIndex = selectedValue
					? listInternal.filteredItems.findIndex((item) => item.value === selectedValue)
					: -1;
				listInternal.selectedIndex = Math.max(0, selectedIndex);
				listInternal.invalidate();
			};

			const pager = new ModalPager();
			let reloading = false;
			let spinnerFrame = 0;
			// Replace the list contents (tab switch or reload) and keep the filter and selection.
			const showData = (data: typeof pickerData, selectedValue?: string) => {
				pickerData = data;
				listInternal.items = data.items;
				listInternal.maxVisible = Math.max(1, data.items.length);
				listInternal.layout = {
					minPrimaryColumnWidth: data.widestLabel + 2,
					maxPrimaryColumnWidth: data.widestLabel + 2,
				};
				applyFuzzy(search.getValue?.() ?? "", selectedValue);
				pager.followSelection();
			};
			const reload = async () => {
				if (reloading) return;
				reloading = true;
				const spinnerTimer = setInterval(() => {
					spinnerFrame = (spinnerFrame + 1) % SPINNER.length;
					tui.requestRender();
				}, 120);
				tui.requestRender();
				try {
					const selectedValue = list.getSelectedItem()?.value;
					registry.refresh?.();
					const refreshed = await registry.getAvailable();
					if (refreshed.length === 0) {
						ctx.ui.notify("No models with configured auth.", "warning");
						return;
					}
					available = refreshed;
					[classifiers, images] = await loadTyped();
					showData(buildPickerData(tab), selectedValue);
				} catch (error) {
					ctx.ui.notify(`Failed to reload models: ${String(error)}`, "error");
				} finally {
					clearInterval(spinnerTimer);
					reloading = false;
					tui.requestRender();
				}
			};

			// Swap the list to another tab's models. Chat keeps the current model selected.
			const counts = () => ({
				chat: available.length,
				classifier: classifiers.length,
				image: images.length,
			});
			const switchTab = (dir: -1 | 1) => {
				const idx = MODEL_TABS.findIndex((t) => t.id === tab);
				tab = MODEL_TABS[(idx + dir + MODEL_TABS.length) % MODEL_TABS.length]?.id ?? "chat";
				showData(buildPickerData(tab), tab === "chat" ? currentValue : undefined);
			};
			const tabBar = () => {
				const n = counts();
				return MODEL_TABS.map(({ id, label }) => {
					const text = `  ${label} ${n[id]}  `;
					return id === tab ? theme.fg(accent, theme.bold(text)) : mute(text);
				}).join(mute("│"));
			};

			// Live thinking-level readout. ←/→ mutates the session immediately via
			// pi.setThinkingLevel() and steps only through the levels the active model
			// supports (its thinkingLevelMap), so every keypress lands on a real level.
			//
			// `local` shadows the level so the header updates even on builds/contexts
			// where pi.getThinkingLevel() lags or is unavailable inside the overlay.
			let localLevel = pi.getThinkingLevel?.() ?? "";
			const supportedLevels = (): string[] =>
				ctx.model ? getSupportedThinkingLevels(ctx.model) : [];
			const thinkLine = () => {
				const resolved = pi.getThinkingLevel?.() ?? localLevel;
				const levels = supportedLevels();
				const ladder = levels.length
					? levels
							.map((level) =>
								level === resolved
									? theme.getThinkingBorderColor(level)(theme.bold(`[${level}]`))
									: theme.fg("muted", level),
							)
							.join(" ")
					: theme.fg("dim", resolved || "—");
				return (
					theme.fg("dim", "Thinking: ") +
					ladder +
					theme.fg("muted", "  (") +
					guide("←/→", "adjust") +
					theme.fg("muted", ")")
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
							tabBar(),
							reloading
								? theme.fg("accent", `${SPINNER[spinnerFrame] ?? ""} Reloading models…`)
								: theme.fg("dim", MODEL_TABS.find((t) => t.id === tab)?.hint ?? ""),
							// Thinking applies to the session chat model only.
							...(tab === "chat" ? [thinkLine()] : []),
							...search.render(inner),
							"",
						],
						body: list.render(inner),
						selectedBodyRange: (() => {
							// SAFETY: SelectList tracks selectedIndex internally for pager synchronization.
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
								guide("tab", "type") +
								guideSep +
								(tab === "chat" ? guide("←/→", "thinking") + guideSep : "") +
								guide("^r", "reload") +
								guideSep +
								guide("enter", tab === "chat" ? "select" : "usage") +
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
					// ctrl+r refreshes and replaces list data without disposing the overlay.
					if (matchesKey(data, Key.ctrl("r"))) {
						void reload();
						return;
					}
					if (reloading) return;
					const shiftTab = matchesKey(data, Key.shift(Key.tab));
					if (shiftTab || matchesKey(data, Key.tab)) {
						switchTab(shiftTab ? -1 : 1);
						tui.requestRender();
						return;
					}
					// Non-chat tabs: ←/→ falls through to the search input cursor.
					let dir: -1 | 1 | 0 = 0;
					if (tab === "chat" && matchesKey(data, Key.left)) dir = -1;
					else if (tab === "chat" && matchesKey(data, Key.right)) dir = 1;
					if (dir !== 0) {
						const cur = pi.getThinkingLevel?.() || localLevel || "medium";
						const next = stepThinkingLevel(supportedLevels(), cur, dir);
						pi.setThinkingLevel(next as Parameters<typeof pi.setThinkingLevel>[0]);
						localLevel = pi.getThinkingLevel?.() ?? next;
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
		{ overlay: true, overlayOptions: modalOverlayOptions() },
	);

	if (!result) return;

	if (result.startsWith(CLASSIFIER_VALUE_PREFIX)) {
		const ref = result.slice(CLASSIFIER_VALUE_PREFIX.length);
		ctx.ui.notify(
			`${ref} is a classifier model, not a chat model. Call it with models.classify() in codemode or ctx.modelRegistry.classify().`,
			"info",
		);
		return;
	}
	if (result.startsWith(IMAGE_VALUE_PREFIX)) {
		const ref = result.slice(IMAGE_VALUE_PREFIX.length);
		ctx.ui.notify(
			`${ref} is an image model, not a chat model. Call it with models.generateImages() in codemode.`,
			"info",
		);
		return;
	}

	// Apply selection
	const [provider, ...rest] = result.split("/");
	const id = rest.join("/");
	const picked = available.find((m) => m.provider === provider && m.id === id);
	if (!picked) {
		ctx.ui.notify(`Model not found: ${result}`, "error");
		return;
	}
	const ok = await pi.setModel(picked);
	if (!ok) {
		ctx.ui.notify(`Failed to switch to ${picked.id}`, "error");
		return;
	}
	// Persistence happens in project-prefs.ts via the model_select event.
}

export default function modelPickerExtension(pi: ExtensionAPI) {
	// Remove Pi's built-in /model so only the enhanced /models picker remains.
	// Self-healing: re-applies on every load, so a Pi upgrade can't restore it.
	patchOutBuiltinModelCommand();

	const handler = async (_args: unknown, ctx: ExtensionContext) => {
		await showEnhancedPicker(pi, ctx);
	};
	registerProjectPrefs(pi);
	pi.registerCommand("models", {
		description: "Enhanced model picker — shows benchlm rank + score",
		handler,
	});
}
