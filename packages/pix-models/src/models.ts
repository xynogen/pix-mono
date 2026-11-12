/**
 * models.ts — enhanced /model command with benchlm rank + score
 *
 * Takes over Pi's built-in /model name (see patch-builtin.ts). Each row shows:
 *   <name>  <provider> · <ctx> · <cost> · 🏅 #rank score
 *
 * Sorted by benchlm rank when available (best first), then alphabetical.
 */

import { getSupportedThinkingLevels } from "@xynogen/pix-data/ai";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import {
	frameModal,
	MIN_MODAL_HEIGHT,
	ModalPager,
	modalOverlayOptions,
	modalWidth,
	terminalModalHeight,
} from "@xynogen/pix-pretty/modal-frame";
import { Input, Key, matchesKey, type SelectItem, SelectList } from "@xynogen/pix-pretty/tui";
import { SPINNER } from "@xynogen/pix-pretty/widget-format";
import type { ExtensionAPI, ExtensionContext } from "@xynogen/pix-runtime/host";
import { ioTimeoutSignal } from "@xynogen/pix-runtime/io";
import { filterModelItems, MODEL_TABS, type ModelTab, stepThinkingLevel } from "./lib.ts";
import { patchOutBuiltinModelCommand } from "./patch-builtin";
import { buildPickerData, nonChatNotice } from "./picker-rows.ts";
import { registerProjectPrefs } from "./project-prefs";
import { reasoningCatalog, withReasoningLevels } from "./thinking.ts";

// Matches Pi's built-in selector refresh deadline.
const MODEL_REFRESH_TIMEOUT_MS = 15_000;

async function showEnhancedPicker(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	initialSearch = "",
): Promise<void> {
	// Open from the current snapshot so the picker appears immediately, then refresh
	// provider catalogs in the background like Pi's built-in selector. ModelRegistry.refresh()
	// is async in Pi 1.5: getAvailable() reads the snapshot, so it must run after refresh resolves.
	// The public ExtensionContext type narrows modelRegistry; at runtime it is the full registry.
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
		refresh?: (options?: {
			force?: boolean;
			signal?: AbortSignal;
		}) => Promise<{ aborted: boolean; errors: ReadonlyMap<string, Error> }> | undefined;
		getAvailable(): AvailableModels | Promise<AvailableModels>;
		getAvailableOfType?: (type: "classifier" | "image") => Promise<readonly TypedModel[]>;
	};
	// Classifier and image models are not chat models. Each gets its own tab so
	// they are visible but never picked as the session model.
	const loadOfType = async (type: "classifier" | "image") =>
		(await registry.getAvailableOfType?.(type).catch(() => [])) ?? [];
	const loadTyped = () => Promise.all([loadOfType("classifier"), loadOfType("image")]);
	let available = await registry.getAvailable();
	let [classifiers, images] = await loadTyped();
	if (available.length === 0) {
		await registry.refresh?.({ signal: ioTimeoutSignal(undefined, MODEL_REFRESH_TIMEOUT_MS) });
		available = await registry.getAvailable();
		[classifiers, images] = await loadTyped();
	}
	if (available.length === 0) {
		ctx.ui.notify("No models with configured auth.", "warning");
		return;
	}

	const catalog = available.some((model) => model.reasoning) ? await reasoningCatalog.get() : [];
	let current = ctx.model ? withReasoningLevels(ctx.model, catalog) : undefined;

	const result = await ctx.ui.custom<string | null>(
		(tui, theme, _kb, done) => {
			const accent = "accent";
			const mute = (s: string) => theme.fg("muted", s);
			const guide = (key: string, action: string) =>
				theme.fg("text", key) + theme.fg("muted", ` ${action}`);
			const guideSep = theme.fg("muted", " · ");

			let tab: ModelTab = "chat";
			const currentValue = current ? `${current.provider}/${current.id}` : undefined;

			const buildData = (forTab: ModelTab) =>
				buildPickerData(forTab, { chat: available, classifiers, images }, theme, currentValue);
			let pickerData = buildData(tab);
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
			// Closing the picker cancels its catalog refresh; Pi keeps shared refreshes alive for other callers.
			const closed = new AbortController();
			const finish = (value: string | null) => {
				closed.abort();
				done(value);
			};
			list.onSelect = (item) => finish(item.value);
			list.onCancel = () => finish(null);
			search.onEscape = () => finish(null);

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
			// `/model <term>` opens pre-filtered, like Pi's own picker.
			if (initialSearch) {
				search.setValue(initialSearch);
				applyFuzzy(initialSearch);
			}

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
			let forceQueued = false;
			const reload = async (force: boolean) => {
				// Ctrl+R during the opening refresh must still force a live fetch afterwards.
				if (reloading) {
					forceQueued ||= force;
					return;
				}
				reloading = true;
				const spinnerTimer = setInterval(() => {
					spinnerFrame = (spinnerFrame + 1) % SPINNER.length;
					tui.requestRender();
				}, 120);
				tui.requestRender();
				try {
					const signal = ioTimeoutSignal(closed.signal, MODEL_REFRESH_TIMEOUT_MS);
					const outcome = await registry.refresh?.({ force, signal });
					if (closed.signal.aborted) return;
					if (outcome?.aborted)
						ctx.ui.notify("Model refresh timed out; showing cached models.", "warning");
					else if (outcome?.errors.size)
						ctx.ui.notify(
							`Model refresh failed for ${[...outcome.errors.keys()].join(", ")}; showing cached models.`,
							"warning",
						);
					const refreshed = await registry.getAvailable();
					const typed = await loadTyped();
					if (closed.signal.aborted) return;
					if (refreshed.length === 0) {
						ctx.ui.notify("No models with configured auth.", "warning");
						return;
					}
					available = refreshed;
					[classifiers, images] = typed;
					// Read the selection after the await: input stays live during refresh.
					showData(buildData(tab), list.getSelectedItem()?.value);
				} catch (error) {
					if (!closed.signal.aborted)
						ctx.ui.notify(`Failed to reload models: ${String(error)}`, "error");
				} finally {
					clearInterval(spinnerTimer);
					reloading = false;
					if (!closed.signal.aborted) {
						tui.requestRender();
						if (forceQueued) {
							forceQueued = false;
							void reload(true);
						}
					}
				}
			};
			void reload(false);

			// Swap the list to another tab's models. Chat keeps the current model selected.
			const counts = () => ({
				chat: available.length,
				classifier: classifiers.length,
				image: images.length,
			});
			const switchTab = (dir: -1 | 1) => {
				const idx = MODEL_TABS.findIndex((t) => t.id === tab);
				tab = MODEL_TABS[(idx + dir + MODEL_TABS.length) % MODEL_TABS.length]?.id ?? "chat";
				showData(buildData(tab), tab === "chat" ? currentValue : undefined);
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
			let applyingThinking = false;
			let needsThinkingModel = current !== ctx.model;
			const supportedLevels = (): string[] => (current ? getSupportedThinkingLevels(current) : []);
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
				async handleInput(data: string) {
					// Detect keys via pi-tui's own parser — the same recognition
					// SelectList uses. Arrows arrive as named keys ("up"/"down"),
					// not raw escape sequences, so string-equality checks fail.
					const isNav = matchesKey(data, "up") || matchesKey(data, "down");
					// ←/→ tunes the ACTIVE session model's thinking level. setThinkingLevel
					// clamps to model capability, so unsupported rungs land on the nearest allowed.
					// ctrl+r refreshes and replaces list data without disposing the overlay.
					if (matchesKey(data, Key.ctrl("r"))) {
						void reload(true);
						return;
					}
					// Esc must always close, even while a slow reload is in flight.
					if (matchesKey(data, "escape")) {
						finish(null);
						return;
					}
					if (applyingThinking) return;
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
						if (current && needsThinkingModel) {
							applyingThinking = true;
							try {
								if (!(await pi.setModel(current))) throw new Error("Model update rejected");
								needsThinkingModel = false;
								ctx.ui.notify(`Thinking options for ${current.id}: models.dev`, "info");
							} catch (error) {
								current = ctx.model;
								ctx.ui.notify(`Failed to apply thinking options: ${String(error)}`, "error");
								tui.requestRender();
								return;
							} finally {
								applyingThinking = false;
							}
						}
						pi.setThinkingLevel(next as Parameters<typeof pi.setThinkingLevel>[0]);
						localLevel = pi.getThinkingLevel?.() ?? next;
						// setThinkingLevel doesn't repaint this overlay, so force a render
						// now — otherwise the header shows a stale level until the next key.
						tui.requestRender();
						return;
					} else if (isNav || matchesKey(data, "enter")) {
						list.handleInput?.(data);
						if (isNav) pager.followSelection();
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

	const notice = nonChatNotice(result);
	if (notice) {
		ctx.ui.notify(notice, "info");
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
	const enriched = withReasoningLevels(picked, catalog);
	const ok = await pi.setModel(enriched);
	if (!ok) {
		ctx.ui.notify(`Failed to switch to ${picked.id}`, "error");
		return;
	}
	if (enriched !== picked) {
		ctx.ui.notify(`Thinking options for ${picked.id}: models.dev`, "info");
	}
	// Persistence happens in project-prefs.ts via the model_select event.
}

export default function modelPickerExtension(pi: ExtensionAPI) {
	// Route Pi's built-in /model (autocomplete entry and submit shortcut) to this picker.
	// Self-healing: re-applies on every load, so a Pi upgrade can't restore it.
	patchOutBuiltinModelCommand();

	registerProjectPrefs(pi);
	pi.registerCommand("model", {
		description: "Enhanced model picker — shows benchlm rank + score",
		handler: async (args, ctx) => {
			await showEnhancedPicker(pi, ctx, typeof args === "string" ? args.trim() : "");
		},
	});
}
