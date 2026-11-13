/** picker-view.ts — the /model overlay: tabs, fuzzy search, live reload, thinking ladder. */

import type { Api, Model } from "@xynogen/pix-data/ai";
import { getSupportedThinkingLevels } from "@xynogen/pix-data/ai";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import {
	frameModal,
	MIN_MODAL_HEIGHT,
	ModalPager,
	modalWidth,
	terminalModalHeight,
} from "@xynogen/pix-pretty/modal-frame";
import {
	Input,
	Key,
	matchesKey,
	type SelectItem,
	SelectList,
	type Theme,
	type TUI,
} from "@xynogen/pix-pretty/tui";
import { SPINNER } from "@xynogen/pix-pretty/widget-format";
import type { ExtensionAPI, ExtensionContext } from "@xynogen/pix-runtime/host";
import { ioTimeoutSignal } from "@xynogen/pix-runtime/io";
import { filterModelItems, MODEL_TABS, type ModelTab, stepThinkingLevel } from "./lib.ts";
import { buildPickerData, type PickerData, type PickerSource } from "./picker-rows.ts";

// Matches Pi's built-in selector refresh deadline.
export const MODEL_REFRESH_TIMEOUT_MS = 15_000;

type ListInternal = {
	items: SelectItem[];
	filteredItems: SelectItem[];
	selectedIndex: number;
	maxVisible: number;
	layout: { minPrimaryColumnWidth: number; maxPrimaryColumnWidth: number };
	invalidate(): void;
};

/** The model lists the picker shows, reloadable in place. */
export interface ModelSource {
	current: PickerSource;
	/** Refresh provider catalogs; resolves to the new lists, or undefined to keep the old ones.
	 * `closed` aborts when the picker closes: no notices after that. */
	refresh(
		force: boolean,
		signal: AbortSignal,
		closed: AbortSignal,
	): Promise<PickerSource | undefined>;
}

export interface PickerViewDeps {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	tui: TUI;
	theme: Theme;
	source: ModelSource;
	/** The session model, enriched with reasoning levels when the catalog knows them. */
	current: Model<Api> | undefined;
	initialSearch: string;
	done: (value: string | null) => void;
}

export class ModelPickerView {
	private tab: ModelTab = "chat";
	private readonly currentValue: string | undefined;
	private pickerData: PickerData;
	private readonly search = new Input();
	private readonly list: SelectList;
	private readonly listInternal: ListInternal;
	// Closing the picker cancels its catalog refresh; Pi keeps shared refreshes alive for other callers.
	private readonly closed = new AbortController();
	private readonly pager = new ModalPager();
	private reloading = false;
	private forceQueued = false;
	private spinnerFrame = 0;
	// Live thinking-level readout. ←/→ mutates the session immediately via
	// pi.setThinkingLevel() and steps only through the levels the active model
	// supports (its thinkingLevelMap), so every keypress lands on a real level.
	// `localLevel` shadows the level so the header updates even on builds/contexts
	// where pi.getThinkingLevel() lags or is unavailable inside the overlay.
	private localLevel: string;
	private applyingThinking = false;
	private current: Model<Api> | undefined;
	private needsThinkingModel: boolean;

	constructor(private readonly d: PickerViewDeps) {
		this.current = d.current;
		this.needsThinkingModel = d.current !== d.ctx.model;
		this.localLevel = d.pi.getThinkingLevel?.() ?? "";
		this.currentValue = d.current ? `${d.current.provider}/${d.current.id}` : undefined;
		this.pickerData = this.buildData();
		const accent = (text: string) => d.theme.fg("accent", text);
		this.list = new SelectList(
			this.pickerData.items,
			Math.max(1, this.pickerData.items.length),
			{
				selectedPrefix: accent,
				selectedText: accent,
				description: (text) => text,
				scrollInfo: (text) => d.theme.fg("muted", text),
				noMatch: (text) => d.theme.fg("warning", text),
			},
			{
				minPrimaryColumnWidth: this.pickerData.widestLabel + 2,
				maxPrimaryColumnWidth: this.pickerData.widestLabel + 2,
			},
		);
		// SAFETY: SelectList has no public item-replacement API; these runtime fields are stable.
		this.listInternal = this.list as unknown as ListInternal;
		const currentIdx = this.currentValue
			? this.pickerData.items.findIndex((item) => item.value === this.currentValue)
			: 0;
		if (currentIdx >= 0) this.list.setSelectedIndex(currentIdx);
		this.list.onSelect = (item) => this.finish(item.value);
		this.list.onCancel = () => this.finish(null);
		this.search.onEscape = () => this.finish(null);
		// `/model <term>` opens pre-filtered, like Pi's own picker.
		if (d.initialSearch) {
			this.search.setValue(d.initialSearch);
			this.applyFuzzy(d.initialSearch);
		}
		void this.reload(false);
	}

	render(w: number): string[] {
		const { theme, tui } = this.d;
		const mw = modalWidth(w);
		const inner = mw - 4; // CHROME = 2 border + 2 padding
		const selected = this.listInternal.selectedIndex;
		const result = frameModal({
			width: mw,
			maxHeight: terminalModalHeight(tui.terminal.rows),
			minHeight: MIN_MODAL_HEIGHT,
			header: [
				theme.fg("accent", theme.bold(`${icon("picker.model")}  Select model`)),
				this.tabBar(),
				this.reloading
					? theme.fg("accent", `${SPINNER[this.spinnerFrame] ?? ""} Reloading models…`)
					: theme.fg("dim", MODEL_TABS.find((t) => t.id === this.tab)?.hint ?? ""),
				// Thinking applies to the session chat model only.
				...(this.tab === "chat" ? [this.thinkLine()] : []),
				...this.search.render(inner),
				"",
			],
			body: this.list.render(inner),
			selectedBodyRange: this.pager.selectedRange({ start: selected, end: selected + 1 }),
			footer: ["", this.footer()],
			bodyOffset: this.pager.bodyOffset,
			color: (s) => theme.fg("accent", s),
			bg: (s) => theme.bg("customMessageBg", s),
			fg: (s) => theme.fg("text", s),
		});
		this.pager.sync(result);
		return result.lines;
	}

	invalidate(): void {
		this.list.invalidate();
		this.search.invalidate();
	}

	async handleInput(data: string): Promise<void> {
		// Detect keys via pi-tui's own parser — the same recognition
		// SelectList uses. Arrows arrive as named keys ("up"/"down"),
		// not raw escape sequences, so string-equality checks fail.
		const isNav = matchesKey(data, "up") || matchesKey(data, "down");
		// ctrl+r refreshes and replaces list data without disposing the overlay.
		if (matchesKey(data, Key.ctrl("r"))) {
			void this.reload(true);
			return;
		}
		// Esc must always close, even while a slow reload is in flight.
		if (matchesKey(data, "escape")) {
			this.finish(null);
			return;
		}
		if (this.applyingThinking) return;
		const shiftTab = matchesKey(data, Key.shift(Key.tab));
		if (shiftTab || matchesKey(data, Key.tab)) {
			this.switchTab(shiftTab ? -1 : 1);
			this.d.tui.requestRender();
			return;
		}
		// Non-chat tabs: ←/→ falls through to the search input cursor.
		if (this.tab === "chat" && (matchesKey(data, Key.left) || matchesKey(data, Key.right))) {
			await this.stepThinking(matchesKey(data, Key.left) ? -1 : 1);
			return;
		}
		if (isNav || matchesKey(data, "enter")) {
			this.list.handleInput?.(data);
			if (isNav) this.pager.followSelection();
		} else {
			this.search.handleInput?.(data);
			this.applyFuzzy(this.search.getValue?.() ?? "");
			this.pager.followSelection();
		}
		this.list.invalidate();
	}

	private finish(value: string | null): void {
		this.closed.abort();
		this.d.done(value);
	}

	private buildData(): PickerData {
		return buildPickerData(this.tab, this.d.source.current, this.d.theme, this.currentValue);
	}

	private guide(key: string, action: string): string {
		return this.d.theme.fg("text", key) + this.d.theme.fg("muted", ` ${action}`);
	}

	private footer(): string {
		const sep = this.d.theme.fg("muted", " · ");
		const chat = this.tab === "chat";
		return [
			this.guide("↑↓", "navigate"),
			this.guide("tab", "type"),
			...(chat ? [this.guide("←/→", "thinking")] : []),
			this.guide("^r", "reload"),
			this.guide("enter", chat ? "select" : "usage"),
			this.guide("esc", "cancel"),
		].join(sep);
	}

	private applyFuzzy(query: string, selectedValue?: string): void {
		const li = this.listInternal;
		li.filteredItems = filterModelItems(li.items, query, this.pickerData);
		const selectedIndex = selectedValue
			? li.filteredItems.findIndex((item) => item.value === selectedValue)
			: -1;
		li.selectedIndex = Math.max(0, selectedIndex);
		li.invalidate();
	}

	/** Replace the list contents (tab switch or reload) and keep the filter and selection. */
	private showData(data: PickerData, selectedValue?: string): void {
		this.pickerData = data;
		const li = this.listInternal;
		li.items = data.items;
		li.maxVisible = Math.max(1, data.items.length);
		li.layout = {
			minPrimaryColumnWidth: data.widestLabel + 2,
			maxPrimaryColumnWidth: data.widestLabel + 2,
		};
		this.applyFuzzy(this.search.getValue?.() ?? "", selectedValue);
		this.pager.followSelection();
	}

	private async reload(force: boolean): Promise<void> {
		// Ctrl+R during the opening refresh must still force a live fetch afterwards.
		if (this.reloading) {
			this.forceQueued ||= force;
			return;
		}
		const { tui, ctx } = this.d;
		this.reloading = true;
		const spinnerTimer = setInterval(() => {
			this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER.length;
			tui.requestRender();
		}, 120);
		tui.requestRender();
		try {
			const signal = ioTimeoutSignal(this.closed.signal, MODEL_REFRESH_TIMEOUT_MS);
			const next = await this.d.source.refresh(force, signal, this.closed.signal);
			if (this.closed.signal.aborted || !next) return;
			this.d.source.current = next;
			// Read the selection after the await: input stays live during refresh.
			this.showData(this.buildData(), this.list.getSelectedItem()?.value);
		} catch (error) {
			if (!this.closed.signal.aborted)
				ctx.ui.notify(`Failed to reload models: ${String(error)}`, "error");
		} finally {
			clearInterval(spinnerTimer);
			this.reloading = false;
			if (!this.closed.signal.aborted) {
				tui.requestRender();
				if (this.forceQueued) {
					this.forceQueued = false;
					void this.reload(true);
				}
			}
		}
	}

	/** Swap the list to another tab's models. Chat keeps the current model selected. */
	private switchTab(dir: -1 | 1): void {
		const idx = MODEL_TABS.findIndex((t) => t.id === this.tab);
		this.tab = MODEL_TABS[(idx + dir + MODEL_TABS.length) % MODEL_TABS.length]?.id ?? "chat";
		this.showData(this.buildData(), this.tab === "chat" ? this.currentValue : undefined);
	}

	private tabBar(): string {
		const { theme } = this.d;
		const src = this.d.source.current;
		const n = {
			chat: src.chat.length,
			classifier: src.classifiers.length,
			image: src.images.length,
		};
		return MODEL_TABS.map(({ id, label }) => {
			const text = `  ${label} ${n[id]}  `;
			return id === this.tab ? theme.fg("accent", theme.bold(text)) : theme.fg("muted", text);
		}).join(theme.fg("muted", "│"));
	}

	private supportedLevels(): string[] {
		return this.current ? getSupportedThinkingLevels(this.current) : [];
	}

	private thinkLine(): string {
		const { theme, pi } = this.d;
		const resolved = pi.getThinkingLevel?.() ?? this.localLevel;
		const levels = this.supportedLevels();
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
			this.guide("←/→", "adjust") +
			theme.fg("muted", ")")
		);
	}

	/** ←/→ tunes the ACTIVE session model's thinking level. setThinkingLevel clamps to model
	 * capability, so unsupported rungs land on the nearest allowed. */
	private async stepThinking(dir: -1 | 1): Promise<void> {
		const { pi, ctx, tui } = this.d;
		const cur = pi.getThinkingLevel?.() || this.localLevel || "medium";
		const next = stepThinkingLevel(this.supportedLevels(), cur, dir);
		if (this.current && this.needsThinkingModel) {
			this.applyingThinking = true;
			try {
				if (!(await pi.setModel(this.current))) throw new Error("Model update rejected");
				this.needsThinkingModel = false;
				ctx.ui.notify(`Thinking options for ${this.current.id}: models.dev`, "info");
			} catch (error) {
				this.current = ctx.model;
				ctx.ui.notify(`Failed to apply thinking options: ${String(error)}`, "error");
				tui.requestRender();
				return;
			} finally {
				this.applyingThinking = false;
			}
		}
		pi.setThinkingLevel(next as Parameters<typeof pi.setThinkingLevel>[0]);
		this.localLevel = pi.getThinkingLevel?.() ?? next;
		// setThinkingLevel doesn't repaint this overlay, so force a render
		// now — otherwise the header shows a stale level until the next key.
		tui.requestRender();
	}
}
