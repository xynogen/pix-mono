/**
 * pix-command.ts — the `/pix` command: unified settings overlay for pix.json.
 *
 * Runtime owns this because it edits the shared document. Rows are declared
 * here against typed sections; persistence goes through `runtime.update()`.
 * Headless hosts get a notify summary instead of the overlay.
 */

import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	Key,
	type KeybindingsManager,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type BinariesTab, createBinariesTab } from "./binaries-tab.ts";
import { icon } from "./icon-catalog.ts";
import { isPackageLoaded } from "./once.ts";
import { type PixRuntime, pixRuntime } from "./runtime.ts";
import { type DeepPartial, deepMerge, type SectionHandle } from "./schema.ts";
import { collapseSection } from "./sections/collapse.ts";
import { compactionSection } from "./sections/compaction.ts";
import { editSection } from "./sections/edit.ts";
import { gateSection } from "./sections/gate.ts";
import { ioSection } from "./sections/io.ts";
import { prettySection, type RenderSize } from "./sections/pretty.ts";

interface SettingRow<T> {
	section: string;
	label: string;
	handle: SectionHandle<string, T>;
	values: readonly string[];
	read: (v: T) => string;
	patch: (value: string) => DeepPartial<T>;
}

/** Capture a row's section type, then erase it so rows can share one list. */
function row<T>(r: SettingRow<T>): SettingRow<unknown> {
	return r as SettingRow<unknown>;
}

/** Pi-owned theme row: not stored in pix.json, applied through `ctx.ui.setTheme`. */
interface ThemeRow {
	kind: "theme";
	section: string;
	label: string;
	values: readonly string[];
	current: () => string;
}

type Row = SettingRow<unknown> | ThemeRow;

function isThemeRow(row: Row): row is ThemeRow {
	return "kind" in row;
}

/** Render a token count as a compact label: 1_000_000 → "1M", 150_000 → "150k". */
function formatTokens(tokens: number): string {
	return tokens % 1_000_000 === 0 ? `${tokens / 1_000_000}M` : `${tokens / 1000}k`;
}

function parseRenderSize(value: string): RenderSize {
	return value.endsWith("%") ? (value as `${number}%`) : Number.parseFloat(value);
}

function resolveRenderSize(limit: RenderSize, available: number): number {
	if (typeof limit === "number") return Math.floor(limit);
	return Math.floor((available * Number.parseFloat(limit)) / 100);
}

/** Parse a compact token label ("1M", "150k") back to an absolute count. */
function parseTokens(label: string): number {
	const raw = label.trim();
	const m = raw.match(/^([0-9]*\.?[0-9]+)\s*([km])?$/i);
	if (!m) return Number.NaN;
	const numStr = m[1] ?? "";
	const n = Number.parseFloat(numStr);
	if (!Number.isFinite(n)) return Number.NaN;
	const suf = (m[2] ?? "").toLowerCase();
	return suf === "m" ? Math.round(n * 1_000_000) : Math.round(n * 1000);
}

const SETTINGS: SettingRow<unknown>[] = [
	row({
		section: "Pretty",
		label: "icons",
		handle: prettySection,
		values: ["nerd", "unicode", "ascii"],
		read: (v) => v.icons,
		patch: (value) => ({ icons: value as "nerd" | "unicode" | "ascii" }),
	}),
	row({
		section: "Pretty",
		label: "ls style",
		handle: prettySection,
		values: ["grid", "tree"],
		read: (v) => v.lsStyle,
		patch: (value) => ({ lsStyle: value as "grid" | "tree" }),
	}),
	row({
		section: "Pretty",
		label: "max modal width",
		handle: prettySection,
		values: [
			"50%",
			"55%",
			"60%",
			"65%",
			"70%",
			"75%",
			"80%",
			"85%",
			"90%",
			"95%",
			"100%",
			"72 cols",
			"80 cols",
			"88 cols",
			"96 cols",
			"104 cols",
			"120 cols",
		],
		read: (v) =>
			typeof v.maxRenderWidth === "number" ? `${v.maxRenderWidth} cols` : v.maxRenderWidth,
		patch: (value) => ({ maxRenderWidth: parseRenderSize(value) }),
	}),
	row({
		section: "Pretty",
		label: "max modal height",
		handle: prettySection,
		values: [
			"50%",
			"55%",
			"60%",
			"65%",
			"70%",
			"75%",
			"80%",
			"85%",
			"90%",
			"95%",
			"100%",
			"12 rows",
			"16 rows",
			"20 rows",
			"24 rows",
		],
		read: (v) =>
			typeof v.maxRenderHeight === "number" ? `${v.maxRenderHeight} rows` : v.maxRenderHeight,
		patch: (value) => ({ maxRenderHeight: parseRenderSize(value) }),
	}),
	row({
		section: "Collapse",
		label: "enabled",
		handle: collapseSection,
		values: ["true", "false"],
		read: (v) => String(v.enabled),
		patch: (value) => ({ enabled: value === "true" }),
	}),
	row({
		section: "Collapse",
		label: "delay (sec)",
		handle: collapseSection,
		values: ["5", "10", "15", "20", "30", "60"],
		read: (v) => String(v.delaySec),
		patch: (value) => ({ delaySec: Number(value) }),
	}),
	row({
		section: "Network",
		label: "timeout (sec)",
		handle: ioSection,
		values: ["30", "10", "60", "120", "300"],
		read: (v) => String(v.timeoutSec),
		patch: (value) => ({ timeoutSec: Number(value) }),
	}),
	row({
		section: "Compaction",
		label: "Trigger (% ctx)",
		handle: compactionSection,
		// 0–100 in 5% steps.
		values: Array.from({ length: 21 }, (_, i) => String(i * 5)),
		read: (v) => String(v.triggerPercent),
		patch: (value) => ({ triggerPercent: Number(value) }),
	}),
	row({
		section: "Compaction",
		label: "Minimum tokens",
		handle: compactionSection,
		values: ["25k", "50k", "100k", "150k", "200k", "300k", "400k", "600k", "800k", "1M"],
		read: (v) => formatTokens(v.minimumTokens),
		patch: (value) => ({ minimumTokens: parseTokens(value) }),
	}),
	row({
		section: "Edit",
		label: "syntax guard",
		handle: editSection,
		values: ["off", "on"],
		read: (v) => (v.rejectNewSyntaxErrors ? "on" : "off"),
		patch: (value) => ({ rejectNewSyntaxErrors: value === "on" }),
	}),
	row({
		section: "Gate",
		label: "Guardrails",
		handle: gateSection,
		values: ["on", "off"],
		read: (v) => v.guardrails,
		patch: (guardrails) => ({ guardrails: guardrails as "on" | "off" }),
	}),
	...Object.keys(prettySection.defaults.footer).map((key) => {
		const part = key as keyof typeof prettySection.defaults.footer;
		return row({
			section: "Footer",
			get label() {
				const key = {
					mode: "status.active",
					cwd: "cwd",
					git: "git.unstaged",
					context: "tokens",
					model: "model",
					thinking: "agent",
					score: "score",
					statuses: "status.running",
					tokens: "tokens",
					cost: "data.float",
					tps: "score",
					system: "sys.cpu",
					clock: "clock",
					wrap: "turns",
				} as const;
				const glyph = icon(key[part]);
				const iconW = Math.max(2, ...Object.values(key).map((key) => visibleWidth(icon(key))));
				return `${glyph}${" ".repeat(iconW - visibleWidth(glyph))} ${part === "wrap" ? "wrap line" : part}`;
			},
			handle: prettySection,
			values: part === "wrap" ? ["on", "off"] : ["show", "hide"],
			read: (v) =>
				part === "wrap" ? (v.footer[part] ? "on" : "off") : v.footer[part] ? "show" : "hide",
			patch: (value) => ({ footer: { [part]: value === "show" || value === "on" } }),
		});
	}),
];

/** Env whose agent dir is the folder holding pix.json (binary.json lives beside it). */
function binariesEnv(runtime: PixRuntime): NodeJS.ProcessEnv {
	return { ...process.env, PI_CODING_AGENT_DIR: dirname(runtime.path) };
}

/**
 * `target` with some properties replaced. Other reads go to `target` itself, so
 * prototype methods keep working and are bound to the real instance (`this`).
 */
function forward<T extends object>(target: T, overrides: Record<string, () => unknown>): T {
	return new Proxy(target, {
		get(obj, key) {
			if (typeof key === "string" && key in overrides) return overrides[key]?.();
			const value = Reflect.get(obj, key, obj);
			return typeof value === "function" ? value.bind(obj) : value;
		},
	});
}

const TABS = ["Settings", "Binaries", "Footer"] as const;
/** Most frequently changed tabs sit leftmost; unknown package tabs go before rare ones. */
const TAB_ORDER = ["Settings", "Tools", "MCP", "Optimizer", "Web", "Voice"];
const RARE_TABS = ["Footer", "Binaries"];
function tabRank(label: string): number {
	const common = TAB_ORDER.indexOf(label);
	if (common >= 0) return common;
	const rare = RARE_TABS.indexOf(label);
	return rare >= 0 ? 100 + rare : 50;
}
const SECTION_PACKAGES: Record<string, string> = {
	Compaction: "pix-core",
	Edit: "pix-diagnostics",
	Gate: "pix-gate",
	Footer: "pix-footer",
};

function visibleSettings(pi: ExtensionAPI): SettingRow<unknown>[] {
	return SETTINGS.filter(
		(row) =>
			!SECTION_PACKAGES[row.section] ||
			isPackageLoaded(pi, SECTION_PACKAGES[row.section] as string),
	);
}

function buildSummary(runtime: PixRuntime, settings: SettingRow<unknown>[]): string {
	const lines = [`Pix Settings (${runtime.path})`, ""];
	let lastSection = "";
	for (const row of settings) {
		if (row.section !== lastSection) {
			if (lastSection) lines.push("");
			lines.push(`[${row.section}]`);
			lastSection = row.section;
		}
		const value = row.read(runtime.get(row.handle));
		const isDefault = value === row.read(row.handle.defaults);
		lines.push(`  ${row.label}: ${value}${isDefault ? "" : " *"}`);
	}
	const binaries = createBinariesTab({
		env: binariesEnv(runtime),
		theme: { fg: (_c, t) => t, bold: (t) => t },
		requestRender: () => {},
	});
	lines.push("", "[Binaries]", ...binaries.summary());
	return lines.join("\n");
}

export type PackageSettings = {
	id: string;
	label: string;
	open(ctx: ExtensionCommandContext): Promise<void>;
};

const SETTINGS_QUERY = "pix:settings";
const COMMAND_QUERY = "pix:settings-command";

/** Register only from an active package factory; Pi clears subscriptions on reload. */
export function registerPackageSettings(pi: ExtensionAPI, settings: PackageSettings): void {
	pi.events?.on(SETTINGS_QUERY, (data: unknown) => {
		if (data instanceof Map) data.set(settings.id, settings);
	});
	registerPixCommand(pi, pixRuntime());
}

function packageSettings(pi: ExtensionAPI): PackageSettings[] {
	const entries = new Map<string, PackageSettings>();
	pi.events?.emit(SETTINGS_QUERY, entries);
	return [...entries.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function registerPixCommand(pi: ExtensionAPI, runtime: PixRuntime): void {
	const claim = { registered: false };
	pi.events?.emit(COMMAND_QUERY, claim);
	if (claim.registered) return;
	pi.events?.on(COMMAND_QUERY, (data: unknown) => {
		if (data && typeof data === "object" && "registered" in data) data.registered = true;
	});
	pi.registerCommand("pix", {
		description: "pix: open shared settings (edit pix.json); /pix <tab> opens that tab",
		getArgumentCompletions: (prefix: string) => {
			const p = prefix.trim().toLowerCase();
			const items = [...TABS, ...packageSettings(pi).map((entry) => entry.label)]
				.map((label) => label.toLowerCase())
				.filter((name) => name.startsWith(p))
				.map((name) => ({ value: name, label: name }));
			return items.length ? items : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			// Re-parse pix.json so section parsers remain the single validation source.
			await runtime.reload({ origin: "command", source: "pix" });
			const panels = packageSettings(pi);
			const settings = visibleSettings(pi);
			// SAFETY: Runtime UI supports custom overlays beyond the published command context type.
			const ui = ctx.ui as unknown as {
				custom?: (f: unknown, opts?: unknown) => Promise<unknown>;
				notify(m: string, t?: "info" | "warning" | "error"): void;
			};

			if (typeof ui.custom !== "function") {
				ui.notify(
					[buildSummary(runtime, settings), ...panels.map((panel) => `[${panel.label}]`)].join(
						"\n",
					),
					"info",
				);
				return;
			}

			await ui.custom(
				(tui: OverlayTui, theme: OverlayTheme, kb: KeybindingsManager, done: (v: null) => void) =>
					new PixSettingsView({
						runtime,
						ctx,
						notify: (m, t) => ui.notify(m, t),
						panels,
						settings,
						themeRow: themeRowFor(ctx),
						args,
						tui,
						theme,
						kb,
						done,
					}),
				{
					overlay: true,
					overlayOptions: () => {
						const pretty = runtime.get(prettySection);
						return {
							anchor: "center",
							width: pretty.maxRenderWidth,
							maxHeight: pretty.maxRenderHeight,
							margin: 2,
						};
					},
				},
			);
		},
	});
}

/** Pi owns the active theme (settings.json); `/pix` only cycles it through `ctx.ui.setTheme`. */
function themeRowFor(ctx: ExtensionCommandContext): ThemeRow | undefined {
	const themeNames = (ctx.ui.getAllThemes?.() ?? []).map((t) => t.name).sort();
	if (themeNames.length <= 1) return undefined;
	return {
		kind: "theme",
		section: "Pretty",
		label: "theme",
		values: themeNames,
		current: () => ctx.ui.theme.name ?? "",
	};
}

/** Advance one setting by one step. A functional updater: the runtime queue serializes writes
 * and the callback sees the latest committed value, so rapid presses each advance exactly one
 * step instead of collapsing on a stale snapshot. */
function stepSetting(
	row: SettingRow<unknown>,
	current: unknown,
	direction: -1 | 1,
): Record<string, unknown> {
	const state: Record<string, unknown> =
		current !== null && typeof current === "object" ? { ...(current as object) } : {};
	let cur = row.values.indexOf(row.read(state));
	// ponytail: unsupported custom values snap to section default on first change.
	if (cur === -1) {
		const defIdx = row.values.indexOf(row.read(row.handle.defaults));
		cur = defIdx !== -1 ? defIdx - direction : -1;
	}
	const val = row.values[(cur + direction + row.values.length) % row.values.length];
	if (val === undefined) return state;
	return deepMerge(state, row.patch(val) as DeepPartial<Record<string, unknown>>);
}

// ── /pix overlay ────────────────────────────────────────────────────────────────────────────

interface OverlayTui {
	requestRender(): void;
	terminal?: { rows?: number };
}

interface OverlayTheme {
	fg(c: string, t: string): string;
	bg(c: string, t: string): string;
	bold(t: string): string;
}

interface EmbeddedPanel {
	render(width: number): string[];
	handleInput(data: string): void;
	dispose?(): void;
}

type ModalFrame = Omit<
	RuntimeModalOptions,
	"header" | "body" | "footer" | "bodyOffset" | "selectedBodyLine"
>;

interface SettingsViewDeps {
	runtime: PixRuntime;
	ctx: ExtensionCommandContext;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	panels: PackageSettings[];
	settings: SettingRow<unknown>[];
	themeRow: ThemeRow | undefined;
	args: string;
	tui: OverlayTui;
	theme: OverlayTheme;
	kb: KeybindingsManager;
	done: (value: null) => void;
}

const CLOSE_GUIDES: Array<[string, string]> = [
	["tab", "switch tab"],
	["esc", "close"],
];
const SETTINGS_GUIDES: Array<[string, string]> = [
	["←→", "change"],
	["↑↓", "move"],
	["PgUp/PgDn", "inspect"],
	...CLOSE_GUIDES,
];

/** The `/pix` overlay: built-in tabs (Settings, Binaries, Footer) plus package panels as tabs. */
class PixSettingsView {
	private selected = 0;
	private bodyOffset = 0;
	private visibleBodyLines = 1;
	private maxBodyOffset = 0;
	private inspectingPage = false;
	private readonly tabs: string[];
	private tab: string;
	private embedded: EmbeddedPanel | undefined;
	private leavePanel: (() => void) | undefined;
	private panelGeneration = 0;
	private panelShrink = 1;
	private binaries: BinariesTab | undefined;

	constructor(private readonly d: SettingsViewDeps) {
		this.tabs = [
			...TABS.filter(
				(name) => name !== "Footer" || d.settings.some((row) => row.section === "Footer"),
			),
			...d.panels.map((entry) => entry.label),
		].sort((a, b) => tabRank(a) - tabRank(b));
		const wanted = (d.args ?? "").trim().toLowerCase();
		this.tab = this.tabs.find((name) => name.toLowerCase() === wanted) ?? "Settings";
		// `/pix <tab>` opens straight into that tab.
		if (this.tab === "Binaries") this.binariesTab().refresh();
		this.mountPanel();
	}

	render(width: number): string[] {
		const { runtime, theme, tui } = this.d;
		const frame: ModalFrame = {
			width,
			maxHeight: modalHeight(tui.terminal?.rows, runtime.get(prettySection).maxRenderHeight),
			title: `${icon("settings")} Pix Settings`,
			titleColor: (s: string) => theme.fg("accent", theme.bold(s)),
			color: (s: string) => theme.fg("accent", s),
			bg: (s: string) => theme.bg("customMessageBg", s),
		};
		if (this.tab === "Binaries") return this.renderBinaries(width, frame);
		if (!this.isBuiltinTab()) return this.renderPanel(width, frame);
		return this.renderSettings(width, frame);
	}

	dispose(): void {
		this.panelGeneration++;
		this.leavePanel?.();
		this.embedded?.dispose?.();
	}

	/** Nothing is cached between frames: render() rebuilds from live state. */
	invalidate(): void {}

	handleInput(data: string): void {
		const { kb, tui } = this.d;
		if (this.tab === "Binaries" && this.binariesTab().editing) {
			this.binariesEditInput(data);
			return;
		}
		const shiftTab = matchesKey(data, Key.shift(Key.tab));
		if (shiftTab || matchesKey(data, Key.tab)) {
			this.switchTab(shiftTab ? -1 : 1);
			tui.requestRender();
			return;
		}
		if (!this.isBuiltinTab() && this.embedded) {
			this.embedded.handleInput(data);
			return;
		}
		if (this.pageInput(data)) return;
		// matchesKey handles both legacy bytes and Kitty CSI-u encodings
		// for letters and special keys alike — raw string compares like
		// `data === "k"` silently fail under the Kitty keyboard protocol.
		if (kb.matches(data, "tui.select.cancel")) {
			if (this.tab === "Binaries" && this.binariesTab().clearFilter()) tui.requestRender();
			else this.d.done(null);
			return;
		}
		if (this.tab === "Binaries") {
			this.binariesInput(data);
			return;
		}
		if (kb.matches(data, "tui.select.up")) this.move(-1);
		else if (kb.matches(data, "tui.select.down")) this.move(1);
		else if (matchesKey(data, Key.left)) this.cycle(-1);
		else if (matchesKey(data, Key.right)) this.cycle(1);
		else return;
		tui.requestRender();
	}

	private isBuiltinTab(): boolean {
		return TABS.some((name) => name === this.tab);
	}

	private guides(pairs: Array<[string, string]>): string {
		const { theme } = this.d;
		return pairs
			.map(([key, action]) => theme.fg("text", key) + theme.fg("muted", ` ${action}`))
			.join(theme.fg("muted", " · "));
	}

	private binariesTab(): BinariesTab {
		this.binaries ??= createBinariesTab({
			env: binariesEnv(this.d.runtime),
			theme: this.d.theme,
			requestRender: () => this.d.tui.requestRender(),
		});
		return this.binaries;
	}

	private mountPanel(): void {
		const generation = ++this.panelGeneration;
		this.leavePanel?.();
		this.embedded?.dispose?.();
		this.embedded = undefined;
		this.leavePanel = undefined;
		const panel = this.d.panels.find((entry) => entry.label === this.tab);
		if (!panel) return;
		void panel.open(this.panelContext(generation)).catch((error) => {
			if (generation !== this.panelGeneration) return;
			const message = error instanceof Error ? error.message : String(error);
			this.d.notify(`pix: ${panel.label}: ${message}`, "error");
		});
	}

	/** Command context whose `ui.custom` mounts the panel inside this overlay, not a new one. */
	private panelContext(generation: number): ExtensionCommandContext {
		const { ctx, tui, theme, kb, done } = this.d;
		// SAFETY: spreads the real command context and only overrides ui.custom, so the full shape is kept.
		return {
			...ctx,
			ui: {
				...ctx.ui,
				custom: async (
					factory: (
						tui: unknown,
						theme: unknown,
						kb: unknown,
						done: (value: unknown) => void,
					) => EmbeddedPanel,
				) => {
					if (generation !== this.panelGeneration) return null;
					return new Promise<unknown>((resolve) => {
						this.leavePanel = () => resolve(null);
						// The /pix tab row takes one line; render() shrinks the panel's terminal until both fit.
						// Proxies, not spreads: the real TUI and terminal are class instances whose
						// methods (requestRender, columns) live on the prototype and a spread drops them.
						const terminal = tui.terminal ?? {};
						const panelTerminal = forward(terminal, {
							rows: () =>
								Math.max(1, (terminal.rows ?? process.stdout.rows ?? 24) - this.panelShrink),
						});
						const panelTui = forward(tui, { terminal: () => panelTerminal });
						this.embedded = factory(panelTui, theme, kb, (value: unknown) => {
							if (generation !== this.panelGeneration) return resolve(null);
							if (value == null) {
								this.embedded = undefined;
								done(null);
							}
							resolve(value);
						});
						tui.requestRender();
					});
				},
			},
		} as unknown as ExtensionCommandContext;
	}

	private tabBar(width: number): string {
		const { theme } = this.d;
		const full = this.tabs
			.map((name) =>
				name === this.tab
					? theme.fg("accent", theme.bold(`  ${name}  `))
					: theme.fg("muted", `  ${name}  `),
			)
			.join(theme.fg("muted", "│"));
		if (visibleWidth(full) <= width) return full;
		return (
			theme.fg("accent", theme.bold(`  ${this.tab}  `)) +
			theme.fg("muted", `${this.tabs.indexOf(this.tab) + 1}/${this.tabs.length}`)
		);
	}

	private switchTab(direction: -1 | 1): void {
		const next = (this.tabs.indexOf(this.tab) + direction + this.tabs.length) % this.tabs.length;
		this.tab = this.tabs[next] ?? "Settings";
		this.selected = 0;
		this.bodyOffset = 0;
		this.inspectingPage = false;
		if (this.tab === "Binaries") this.binariesTab().refresh();
		this.mountPanel();
	}

	private rows(): Row[] {
		const list = this.d.settings.filter(
			(r) => (r.section === "Footer") === (this.tab === "Footer"),
		);
		return this.tab === "Settings" && this.d.themeRow ? [this.d.themeRow, ...list] : list;
	}

	private move(direction: -1 | 1): void {
		const count = this.rows().length;
		this.selected = (this.selected + direction + count) % count;
		this.inspectingPage = false;
	}

	private cycle(direction: -1 | 1): void {
		const row = this.rows()[this.selected];
		if (!row) return;
		if (isThemeRow(row)) {
			this.cycleTheme(row, direction);
			return;
		}
		// Re-render AFTER the commit lands; the synchronous render in
		// handleInput fires before the queued write and shows a stale value.
		void this.d.runtime
			.update(row.handle, (current) => stepSetting(row, current, direction), {
				origin: "command",
				source: "pix",
			})
			.then(() => this.d.tui.requestRender())
			.catch(() => this.d.notify(`pix: failed to update ${row.label}`, "error"));
	}

	private cycleTheme(row: ThemeRow, direction: -1 | 1): void {
		const cur = row.values.indexOf(row.current());
		const start = cur === -1 && direction === -1 ? 0 : cur;
		const next = row.values[(start + direction + row.values.length) % row.values.length];
		const result = next ? this.d.ctx.ui.setTheme(next) : undefined;
		if (result && !result.success)
			this.d.notify(`pix: theme ${next}: ${result.error ?? "failed"}`, "error");
		this.d.tui.requestRender();
	}

	private pageInput(data: string): boolean {
		const { kb } = this.d;
		const pageUp = kb?.matches(data, "tui.select.pageUp") || matchesKey(data, Key.pageUp);
		const pageDown = kb?.matches(data, "tui.select.pageDown") || matchesKey(data, Key.pageDown);
		if (!pageUp && !pageDown) return false;
		const direction = pageUp ? -1 : 1;
		this.bodyOffset = pageBodyOffset(
			this.bodyOffset,
			this.visibleBodyLines,
			this.maxBodyOffset,
			direction,
		);
		this.inspectingPage = true;
		this.d.tui.requestRender();
		return true;
	}

	/** Path editor or filter input open: it takes every key (↑↓ move through filter matches). */
	private binariesEditInput(data: string): void {
		const { kb } = this.d;
		const bt = this.binariesTab();
		const nav = !bt.editingPath;
		bt.handleInput(data, {
			up: nav && kb.matches(data, "tui.select.up"),
			down: nav && kb.matches(data, "tui.select.down"),
			enter: false,
		});
		this.inspectingPage = false;
		this.d.tui.requestRender();
	}

	private binariesInput(data: string): void {
		const { kb } = this.d;
		const handled = this.binariesTab().handleInput(data, {
			up: kb.matches(data, "tui.select.up"),
			down: kb.matches(data, "tui.select.down"),
			enter: kb.matches(data, "tui.select.confirm"),
		});
		if (!handled) return;
		this.inspectingPage = false;
		this.d.tui.requestRender();
	}

	/** Frame a scrollable view and keep its scroll state for the next frame and PgUp/PgDn. */
	private framed(opts: RuntimeModalOptions): string[] {
		const result = frameModal(opts);
		this.bodyOffset = result.bodyOffset;
		this.visibleBodyLines = Math.max(1, result.visibleBodyLines);
		this.maxBodyOffset = result.maxBodyOffset;
		return result.lines;
	}

	private renderBinaries(width: number, frame: ModalFrame): string[] {
		const bt = this.binariesTab();
		const view = bt.view(width);
		return this.framed({
			...frame,
			header: [this.tabBar(Math.max(1, width - 4)), "", ...view.header],
			body: view.body,
			footer: ["", this.guides(bt.editing ? view.footer : [...view.footer, ...CLOSE_GUIDES])],
			bodyOffset: this.bodyOffset,
			selectedBodyLine: this.inspectingPage ? undefined : view.selectedBodyLine,
		});
	}

	private renderPanel(width: number, frame: ModalFrame): string[] {
		const { embedded } = this;
		if (!embedded) {
			return frameModal({
				...frame,
				header: [this.tabBar(Math.max(1, width - 4)), ""],
				body: [this.d.theme.fg("dim", `  Loading ${this.tab} settings…`)],
				footer: ["", this.guides(CLOSE_GUIDES)],
				bodyOffset: 0,
			}).lines;
		}
		let lines = embedded.render(width);
		// Keep the composite inside the same budget as built-in tabs.
		for (let tries = 0; lines.length + 1 > frame.maxHeight && tries < 8; tries++) {
			this.panelShrink += lines.length + 1 - frame.maxHeight;
			lines = embedded.render(width);
		}
		const panelWidth = visibleWidth(lines[0] ?? "");
		const bar = frameRows(panelWidth, [this.tabBar(Math.max(1, panelWidth - 4))], frame);
		lines.splice(1, 0, ...bar.slice(1, -1));
		return lines;
	}

	private renderSettings(width: number, frame: ModalFrame): string[] {
		const { runtime, theme } = this.d;
		const rows = this.rows();
		const labelW = Math.max(...rows.map((r) => visibleWidth(r.label)));
		const body: string[] = [];
		const settingBodyLines: number[] = [];
		let lastSection = "";
		for (const [i, row] of rows.entries()) {
			if (row.section !== lastSection) {
				if (lastSection) body.push("");
				body.push(theme.fg("dim", `  ${row.section}`));
				lastSection = row.section;
			}
			const sel = i === this.selected;
			const cursor = sel ? theme.fg("accent", "→") : " ";
			const label = theme.fg(
				sel ? "accent" : "text",
				row.label + " ".repeat(labelW - visibleWidth(row.label)),
			);
			const value = isThemeRow(row) ? row.current() : row.read(runtime.get(row.handle));
			const isDefault = isThemeRow(row) || value === row.read(row.handle.defaults);
			settingBodyLines[i] = body.length;
			body.push(`${cursor} ${label}  ${theme.fg(isDefault ? "dim" : "success", value)}`);
		}
		return this.framed({
			...frame,
			header: [this.tabBar(Math.max(1, width - 4)), ""],
			body,
			footer: ["", this.guides(SETTINGS_GUIDES)],
			bodyOffset: this.bodyOffset,
			selectedBodyLine: this.inspectingPage ? undefined : settingBodyLines[this.selected],
		});
	}
}

// ── Inline modal engine (runtime cannot depend on pix-pretty: pretty depends on runtime) ─

interface RuntimeModalOptions {
	width: number;
	maxHeight: number;
	header: string[];
	body: string[];
	footer: string[];
	bodyOffset: number;
	selectedBodyLine?: number;
	color: (s: string) => string;
	bg?: (s: string) => string;
	/** Plain title embedded in the top border (`╭─ title ──╮`). */
	title?: string;
	/** Color for the embedded title. Defaults to `color`. */
	titleColor?: (s: string) => string;
}

interface RuntimeModalResult {
	lines: string[];
	bodyOffset: number;
	visibleBodyLines: number;
	maxBodyOffset: number;
}

function modalHeight(rows = 24, limit: RenderSize = "80%"): number {
	const safe = Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : 24;
	return Math.max(1, Math.min(safe, resolveRenderSize(limit, safe)));
}

function pageBodyOffset(offset: number, size: number, max: number, direction: -1 | 1): number {
	const s = Math.max(1, size);
	const step = Math.max(1, Math.floor(s / 2));
	return Math.min(max, Math.max(0, offset + direction * step));
}

function fitLines(lines: string[], width: number): string[] {
	const rows: string[] = [];
	for (const line of lines) {
		if (line === "") rows.push("");
		else rows.push(...wrapTextWithAnsi(line, Math.max(1, width)));
	}
	return rows;
}

function frameModal(opts: RuntimeModalOptions): RuntimeModalResult {
	const inner = Math.max(1, opts.width - 4);
	const header = fitLines(opts.header, inner);
	const footer = fitLines(opts.footer, inner);
	const body = fitLines(opts.body, inner);
	const cap = Math.max(1, opts.maxHeight);
	const bodyBudget = cap - 2 - header.length - footer.length;
	const overflows = body.length > Math.max(0, bodyBudget);
	const visibleBodyLines = overflows ? Math.max(0, bodyBudget - 1) : Math.max(0, bodyBudget);
	if (visibleBodyLines === 0 && body.length > 0) {
		return {
			lines: frameRows(opts.width, ["Terminal too short — resize or press esc to cancel"], opts),
			bodyOffset: 0,
			visibleBodyLines: 0,
			maxBodyOffset: 0,
		};
	}
	const maxBodyOffset = Math.max(0, body.length - visibleBodyLines);
	let offset = Math.min(maxBodyOffset, Math.max(0, opts.bodyOffset));
	if (opts.selectedBodyLine !== undefined) {
		const selected = Math.min(
			body.length - 1,
			fitLines(opts.body.slice(0, Math.max(0, opts.selectedBodyLine)), inner).length,
		);
		if (selected < offset) offset = selected;
		else if (selected >= offset + visibleBodyLines) offset = selected - visibleBodyLines + 1;
	}
	const end = Math.min(body.length, offset + visibleBodyLines);
	const lines = [...header];
	if (overflows) {
		const step = Math.max(1, Math.floor(visibleBodyLines / 2));
		const totalPages = Math.max(1, Math.ceil(maxBodyOffset / step) + 1);
		const page = offset >= maxBodyOffset ? totalPages : Math.floor(offset / step) + 1;
		lines.push(`PgUp/PgDn inspect • ${page}/${totalPages}`);
	}
	lines.push(...body.slice(offset, end), ...footer);
	return {
		lines: frameRows(opts.width, lines, opts),
		bodyOffset: offset,
		visibleBodyLines,
		maxBodyOffset,
	};
}

function frameRows(
	width: number,
	lines: string[],
	opts: Pick<RuntimeModalOptions, "color" | "bg" | "title" | "titleColor">,
): string[] {
	const bg = opts.bg ?? ((s: string) => s);
	const inner = Math.max(1, width - 4);
	const dashes = "─".repeat(width - 2);
	// Top border: bare, or `╭─ title ──╮` when a title is given. Chrome around
	// the label is 5 cols (2 corners, 1 lead dash, 2 pad spaces); tail fills the
	// rest so the row stays exactly `width` visible cells.
	const topBorder = ((): string => {
		const span = width - 5;
		if (!opts.title || span < 3) return opts.color(`╭${dashes}╮`);
		const paint = opts.titleColor ?? opts.color;
		const label = truncateToWidth(opts.title, span - 1, "…");
		const tail = "─".repeat(Math.max(1, span - visibleWidth(label)));
		return `${opts.color("╭─ ")}${paint(label)}${opts.color(` ${tail}╮`)}`;
	})();
	const SENTINEL = "\x00";
	const bgOpen = bg(SENTINEL).split(SENTINEL)[0] ?? "";
	const reassert = (s: string): string => {
		if (!bgOpen) return s;
		return s.replace(/\x1b\[([0-9;]*)m/g, (seq, p: string) => {
			if (p === "0" || p.split(";").includes("49")) return `${seq}${bgOpen}`;
			return seq;
		});
	};
	const row = (content: string): string => {
		const fitted = truncateToWidth(content, inner, "…");
		const padded = fitted + " ".repeat(Math.max(0, inner - visibleWidth(fitted)));
		return bg(`${opts.color("│")} ${reassert(padded)} ${opts.color("│")}`);
	};
	return [bg(topBorder), ...lines.map(row), bg(opts.color(`╰${dashes}╯`))];
}
