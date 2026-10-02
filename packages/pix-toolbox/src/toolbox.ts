/**
 * toolbox.ts — /toolbox command for user-driven tool gating
 *
 * Registers a `/toolbox` slash command that opens a TUI picker listing every
 * registered tool (built-in and MCP). Each tool has one of three states:
 *   enabled  — declared in the system prompt (pi.setActiveTools)
 *   deferred — not declared; tool_search loads it on demand (deferred exposure only)
 *   disabled — not declared and blocked, even through tool_search or codemode
 *
 * Also supports headless usage:
 *   /toolbox enable|defer|disable <names>
 *   /toolbox list [query]     — text search (no picker)
 */

import { createHash } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import {
	fuzzyFilter,
	Input,
	Key,
	type KeybindingsManager,
	matchesKey,
	type SelectItem,
	SelectList,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	frameModal,
	MIN_MODAL_HEIGHT,
	ModalPager,
	modalOverlayOptions,
	modalWidth,
	terminalModalHeight,
} from "@xynogen/pix-pretty/modal-frame";
import { config, pixRuntime, updateConfig } from "@xynogen/pix-runtime/config";
import { toolboxSection } from "@xynogen/pix-runtime/sections";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Tools that can never be disabled — always prompt-visible. */
export const CORE_TOOLS: ReadonlySet<string> = new Set(["bash", "edit", "read", "write"]);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ToolRow {
	name: string;
	description: string;
	mcp: boolean;
	source?: string;
	exposure?: string;
}

export type ToolState = "enabled" | "deferred" | "disabled";
export const TOOL_STATES: readonly ToolState[] = ["enabled", "deferred", "disabled"];

/** Callbacks for toggleTool / renderList — test seam. */
export interface ToggleOps {
	stateOf: (name: string) => ToolState;
	/** Returns false when the tool is already in that state. */
	setState: (name: string, state: ToolState) => boolean;
}

/** Only tools registered with `deferred` exposure can be found by tool_search. */
export const canDefer = (row: ToolRow): boolean => row.exposure === "deferred";

/** Next state for the space key. Skips `deferred` when the tool cannot be deferred. */
export function nextState(row: ToolRow, current: ToolState): ToolState {
	const states = TOOL_STATES.filter((s) => s !== "deferred" || canDefer(row));
	return states[(states.indexOf(current) + 1) % states.length] ?? "enabled";
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isMcpTool(info: ToolInfo): boolean {
	return /mcp/i.test(info.sourceInfo?.source ?? "");
}

/**
 * Normal tools first, MCP tools last. Inside a group: enabled, deferred, disabled,
 * then by name. Without `stateOf`, the registered exposure stands in for the state.
 */
export function buildRows(tools: ToolInfo[], stateOf?: (name: string) => ToolState): ToolRow[] {
	const rows = tools
		.filter((t) => !CORE_TOOLS.has(t.name))
		.map((t) => ({
			name: t.name,
			description: firstSentence(t.description ?? ""),
			mcp: isMcpTool(t),
			source: t.sourceInfo?.source,
			exposure: t.exposure ?? "direct",
		}));
	const rank = (r: ToolRow): number =>
		TOOL_STATES.indexOf(stateOf?.(r.name) ?? (r.exposure === "deferred" ? "deferred" : "enabled"));
	return rows.sort(
		(a, b) => Number(a.mcp) - Number(b.mcp) || rank(a) - rank(b) || a.name.localeCompare(b.name),
	);
}

const firstSentence = (desc: string): string => {
	const clean = (desc ?? "").replace(/\s+/g, " ").trim();
	const m = clean.match(/^.*?[.!?](?=\s|$)/);
	return (m ? m[0] : clean).slice(0, 120);
};

export function parseTargets(raw: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const t of raw.split(/[\s,]+/)) {
		const name = t.trim();
		if (!name || seen.has(name)) continue;
		seen.add(name);
		out.push(name);
	}
	return out;
}

const STATUS: Record<ToolState, string> = {
	enabled: "✓ enabled",
	deferred: "~ deferred",
	disabled: "# disabled",
};

export function renderList(
	rows: ToolRow[],
	stateOf: (name: string) => ToolState,
	query?: string,
): string {
	const filtered = query
		? rows.filter(
				(r) =>
					r.name.toLowerCase().includes(query.toLowerCase()) ||
					r.description.toLowerCase().includes(query.toLowerCase()),
			)
		: rows;

	if (!filtered.length) {
		return query ? `No tools matched "${query}".` : "No tools registered.";
	}

	const lines: string[] = [];
	let group = "";
	for (const row of filtered) {
		const nextGroup = row.mcp ? "MCP" : "Tools";
		if (group !== nextGroup) {
			group = nextGroup;
			lines.push(`${lines.length ? "\n" : ""}${group}:`);
		}
		const kind = row.mcp ? "MCP" : "tool";
		lines.push(`${STATUS[stateOf(row.name)]}  ${row.name}  [${kind}]  ${row.description}`);
	}
	return lines.join("\n");
}

const DONE: Record<ToolState, string> = {
	enabled: "now in the prompt",
	deferred: "tool_search loads it on demand",
	disabled: "blocked",
};

export function toggleTool(
	state: ToolState,
	name: string,
	rows: ToolRow[],
	ops: ToggleOps,
): string {
	const row = rows.find((r) => r.name === name);
	if (!row) return `Unknown tool "${name}".`;
	if (CORE_TOOLS.has(name) && state !== "enabled")
		return `${name} is a core tool. It stays enabled.`;
	if (state === "deferred" && !canDefer(row))
		return `${name} has direct exposure. tool_search cannot find it, so it cannot be deferred.`;
	if (!ops.setState(name, state)) return `${name} is already ${state}.`;
	return `${name} ${state} — ${DONE[state]}.`;
}

// ─── Persistence ───────────────────────────────────────────────────────────

/**
 * Persisted gate state. Only changes from the default are saved, so a newly
 * installed tool keeps its default (direct → enabled, deferred → deferred).
 * `disabledTools` holds tools the user disabled. `loadedTools` holds deferred
 * tools the user enabled, so they are declared on every session start.
 * `enabledTools` is the legacy form (an allow-list that hid every tool
 * installed later); it is read once and migrated on the next write.
 */
interface ToolboxState {
	disabledTools?: string[];
	loadedTools?: string[];
	enabledTools?: string[];
}

const isStringArray = (v: unknown): v is string[] =>
	Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * MCP codemode tools are named as JS identifiers now (`mcp__my-srv__a-b` → `mcp__my_srv__a_b`).
 * Map saved names to that form so a disabled tool stays disabled. When `known` lacks that form,
 * the tool collided or passed 64 chars and carries a hash suffix. Rebuild it from the old name.
 * Keep in sync with pix-mcp `codemodeToolName` (packages cannot import each other).
 */
export function migrateToolName(name: string, known?: ReadonlySet<string>): string {
	if (!name.startsWith("mcp__")) return name;
	const plain = name.replace(/[^A-Za-z0-9_]/g, "_");
	if (!known || known.has(plain)) return plain;
	// Server and tool names can both hold `__`, so try every split. Only a known name matches.
	for (let split = name.indexOf("__", 5); split >= 0; split = name.indexOf("__", split + 1)) {
		const key = `${name.slice(5, split)}\0${name.slice(split + 2)}`;
		const hash = createHash("sha256").update(key).digest("hex").slice(0, 8);
		const hashed = `${plain.slice(0, 64 - hash.length - 1)}_${hash}`;
		if (known.has(hashed)) return hashed;
	}
	return plain;
}

/**
 * Disabled tool names from a saved state, or undefined when it holds none.
 * A legacy allow-list maps to "every known non-core tool not in it".
 */
export function disabledFromState(raw: unknown, allNames: string[]): string[] | undefined {
	const state = raw as ToolboxState | undefined;
	if (isStringArray(state?.disabledTools)) {
		const known = new Set(allNames);
		return state.disabledTools
			.map((n) => migrateToolName(n, known))
			.filter((n) => !CORE_TOOLS.has(n));
	}
	if (isStringArray(state?.enabledTools)) {
		const enabled = new Set(state.enabledTools);
		return allNames.filter((n) => !enabled.has(n) && !CORE_TOOLS.has(n));
	}
	return undefined;
}

/** Deferred tool names the user chose to load on every session start. */
export function loadedFromState(raw: unknown, allNames: string[] = []): string[] {
	const loaded = (raw as ToolboxState | undefined)?.loadedTools;
	const known = new Set(allNames);
	return isStringArray(loaded) ? loaded.map((n) => migrateToolName(n, known)) : [];
}

const exposureOf = (tool: ToolInfo): string => tool.exposure ?? "direct";

// ─── State ──────────────────────────────────────────────────────────────────

function createState(pi: ExtensionAPI) {
	let disabledTools = new Set<string>();
	let loadedTools = new Set<string>();
	let initialized = false;

	function isDeferred(name: string): boolean {
		try {
			const tool = pi.getAllTools().find((t) => t.name === name);
			return tool ? exposureOf(tool) === "deferred" : false;
		} catch {
			return false;
		}
	}

	function allNames(): string[] {
		try {
			return (pi.getAllTools() ?? []).map((t) => t.name);
		} catch (err) {
			console.warn("toolbox: getAllTools failed:", err);
			return [];
		}
	}

	function persist(): void {
		const data: ToolboxState = { disabledTools: [...disabledTools].sort() };
		if (loadedTools.size) data.loadedTools = [...loadedTools].sort();
		// Write to session so state survives branch navigation within a session
		try {
			pi.appendEntry<ToolboxState>("toolbox-config", data);
		} catch (err) {
			console.warn("toolbox: persist failed:", err);
		}
		// Write to disk so state survives across completely new sessions
		void updateConfig(toolboxSection, { ...data, loadedTools: data.loadedTools ?? [] })
			.then((change) => {
				if (
					!change &&
					JSON.stringify(config(toolboxSection).disabledTools) !==
						JSON.stringify(data.disabledTools)
				)
					pi.sendMessage({
						customType: "toolbox-error",
						content: "Failed to save toolbox settings to pix.json",
						display: true,
					});
			})
			.catch((err) =>
				pi.sendMessage({
					customType: "toolbox-error",
					content: `Failed to save toolbox settings: ${String(err)}`,
					display: true,
				}),
			);
	}

	/** Raw persisted state from disk, or undefined when absent/corrupt. */
	function loadFromFile(): { raw: unknown; legacy: boolean } | undefined {
		const raw = config(toolboxSection);
		return Object.keys(raw).length ? { raw, legacy: !isStringArray(raw.disabledTools) } : undefined;
	}

	/** Latest toolbox-config entry in the session, or undefined. */
	function loadFromSession(ctx: ExtensionContext): unknown {
		if (!ctx?.sessionManager) return undefined;
		// getEntries() returns ALL entries in the session file — unlike getBranch()
		// which only walks ancestors. Custom entries appended via appendCustomEntry
		// are children of the leaf, not ancestors.
		let saved: unknown;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === "toolbox-config") saved = entry.data;
		}
		return saved;
	}

	function restoreFromBranch(ctx: ExtensionContext): void {
		// Prefer file-based persistence (survives across sessions), then session
		// entries (survive branch navigation), then nothing disabled (first run).
		const names = allNames();
		const file = loadFromFile();
		const fromFile = file ? disabledFromState(file.raw, names) : undefined;
		const fromSession = fromFile ? undefined : loadFromSession(ctx);
		const disabled = fromFile ?? disabledFromState(fromSession, names) ?? [];
		disabledTools = new Set(disabled);
		loadedTools = new Set(loadedFromState(fromFile ? file?.raw : fromSession, names));
		initialized = true;
		apply();
		// Migrate a legacy allow-list file to the disabled-list form.
		if (file?.legacy && fromFile) persist();
	}

	/** Rebuild the active set. `drop` removes one tool that apply() would otherwise keep. */
	function apply(drop?: string): void {
		if (!initialized) return;
		try {
			const tools = pi.getAllTools();
			const active = new Set(pi.getActiveTools());
			if (drop) active.delete(drop);
			pi.setActiveTools(
				tools
					.filter(
						(tool) =>
							!disabledTools.has(tool.name) &&
							(["direct", "model-only"].includes(exposureOf(tool)) ||
								loadedTools.has(tool.name) ||
								active.has(tool.name)),
					)
					.map((tool) => tool.name),
			);
		} catch (err) {
			console.warn("toolbox: setActiveTools failed:", err);
		}
	}

	function stateOf(name: string): ToolState {
		if (disabledTools.has(name)) return "disabled";
		if (pi.getActiveTools().includes(name)) return "enabled";
		return isDeferred(name) ? "deferred" : "disabled";
	}

	function setState(name: string, next: ToolState): boolean {
		if (!initialized || stateOf(name) === next) return false;
		if (CORE_TOOLS.has(name) && next !== "enabled") return false;
		if (next === "deferred" && !isDeferred(name)) return false;
		if (next === "disabled") disabledTools.add(name);
		else disabledTools.delete(name);
		if (next === "enabled" && isDeferred(name)) loadedTools.add(name);
		else loadedTools.delete(name);
		apply(next === "enabled" ? undefined : name);
		persist();
		return true;
	}

	return {
		restoreFromBranch,
		stateOf,
		setState,
		isDisabled: (name: string) => initialized && disabledTools.has(name),
		/** tool_search activates its matches. Re-apply so a disabled match drops out. */
		reapply: () => apply(),
	};
}

// ─── Registration ───────────────────────────────────────────────────────────

export default function registerToolbox(pi: ExtensionAPI): void {
	const state = createState(pi);

	// Defer init until tools are registered — session_start fires after all extensions load.
	// Try to restore persisted state; fall back to full init if no config found.
	pi.on("session_start", async (_event, ctx) => {
		await pixRuntime().init();
		state.restoreFromBranch(ctx);
	});

	// Re-restore when navigating branch history
	pi.on("session_tree", async (_event, ctx) => {
		state.restoreFromBranch(ctx);
	});

	// Disabled means unreachable: block direct and codemode calls, and undo a tool_search load.
	pi.on("tool_call", async (event) => {
		if (!state.isDisabled(event.toolName)) return;
		return {
			block: true,
			reason: `${event.toolName} is disabled in /toolbox. Ask the user to enable it.`,
		};
	});
	pi.on("tool_execution_end", async (event) => {
		if (event.toolName === "tool_search") state.reapply();
	});

	function getRows(): ToolRow[] {
		try {
			return buildRows(pi.getAllTools() ?? [], state.stateOf);
		} catch {
			return [];
		}
	}

	const ops: ToggleOps = { stateOf: state.stateOf, setState: state.setState };

	async function showPicker(ctx: {
		ui: {
			custom: <T>(
				f: unknown,
				opts?: {
					overlay?: boolean;
					overlayOptions?: {
						anchor?: string;
						maxHeight?: number | string;
						width?: number | string;
					};
				},
			) => Promise<T>;
			notify: (m: string, t?: "info" | "warning" | "error") => void;
		};
	}): Promise<void> {
		await ctx.ui.custom<null>(
			(tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (r: null) => void) => {
				const accent = "accent";
				const mute = (s: string) => theme.fg("muted", s);
				const guide = (key: string, action: string) =>
					theme.fg("text", key) + theme.fg("muted", ` ${action}`);
				const guideSep = theme.fg("muted", " · ");

				// Marker + color per state. The text tag keeps state readable without color.
				const LOOK: Record<ToolState, { mark: string; color: "success" | "accent" | "warning" }> = {
					enabled: { mark: "✓", color: "success" },
					deferred: { mark: "~", color: "accent" },
					disabled: { mark: "#", color: "warning" },
				};

				const labelFor = (r: ToolRow): string => {
					const s = ops.stateOf(r.name);
					const look = LOOK[s];
					const name = s === "enabled" ? theme.fg("success", r.name) : theme.fg("muted", r.name);
					return `${theme.fg(look.color, look.mark)} ${name}`;
				};

				const descFor = (r: ToolRow): string => {
					const s = ops.stateOf(r.name);
					const tag = theme.fg(LOOK[s].color, s.padEnd(8));
					return `${tag} ${mute("·")} ${r.description || "(no description)"}`;
				};

				const rows = getRows();
				const byValue = new Map<string, ToolRow>();
				const toItem = (r: ToolRow): SelectItem => {
					byValue.set(r.name, r);
					return {
						value: r.name,
						label: labelFor(r),
						description: descFor(r),
					};
				};

				const allItems = rows.map(toItem);
				const widest = allItems.reduce((w, it) => Math.max(w, visibleWidth(it.label)), 0);

				const list = new SelectList(
					allItems,
					Math.max(1, allItems.length),
					{
						selectedPrefix: (t: string) => theme.fg(accent, t),
						selectedText: (t: string) => theme.fg(accent, t),
						description: (t: string) => t,
						scrollInfo: (t: string) => theme.fg("muted", t),
						noMatch: (t: string) => theme.fg("warning", t),
					},
					{
						minPrimaryColumnWidth: widest + 2,
						maxPrimaryColumnWidth: widest + 2,
					},
				);

				// SAFETY: SelectList exposes these stable fields internally for label refreshes.
				const internal = list as unknown as {
					items: SelectItem[];
					filteredItems: SelectItem[];
					selectedIndex: number;
				};

				const TABS = ["Tools", "MCP"] as const;
				let tab: (typeof TABS)[number] = "Tools";
				const inTab = (it: SelectItem) => (byValue.get(it.value)?.mcp === true) === (tab === "MCP");
				const tabBar = () =>
					TABS.map((name) => {
						const n = rows.filter((r) => r.mcp === (name === "MCP")).length;
						const label = `  ${name} (${n})  `;
						return name === tab ? theme.fg(accent, theme.bold(label)) : mute(label);
					}).join(mute("│"));

				const search = new Input();
				let statusText = "";
				const pager = new ModalPager();

				const refreshLabels = () => {
					for (const it of internal.items) {
						const r = byValue.get(it.value);
						if (!r) continue;
						it.label = labelFor(r);
						it.description = descFor(r);
					}
					list.invalidate();
					tui.requestRender?.();
				};

				const setSelected = (next: ToolState | "cycle") => {
					const sel = list.getSelectedItem();
					const row = sel && byValue.get(sel.value);
					if (!row) return;
					const target = next === "cycle" ? nextState(row, ops.stateOf(row.name)) : next;
					statusText = theme.fg("dim", toggleTool(target, row.name, rows, ops));
					refreshLabels();
				};

				const applyFilter = (q: string) => {
					const query = q.trim();
					const items = internal.items.filter(inTab);
					internal.filteredItems =
						query.length === 0
							? items
							: fuzzyFilter(
									items,
									query,
									(it: SelectItem) => `${it.value} ${it.description ?? ""}`,
								);
					internal.selectedIndex = 0;
					list.invalidate();
				};
				applyFilter("");

				const switchTab = (direction: -1 | 1) => {
					tab = TABS[(TABS.indexOf(tab) + direction + TABS.length) % TABS.length] ?? "Tools";
					statusText = "";
					applyFilter(search.getValue?.() ?? "");
					pager.followSelection();
				};

				list.onSelect = () => done(null);
				list.onCancel = () => done(null);
				search.onEscape = () => done(null);

				return {
					render(w: number) {
						const mw = modalWidth(w);
						const inner = mw - 4; // CHROME = 2 border + 2 padding
						const footer = statusText ? ["", statusText] : [""];
						// maxVisible = all items, so list line i is filteredItems[i].
						const body = list.render(inner);
						const selLine = internal.selectedIndex;
						footer.push(
							guide("tab", "switch tab") +
								guideSep +
								guide("↑↓", "navigate") +
								guideSep +
								guide("←→/PgUp/PgDn", "inspect") +
								guideSep +
								guide("^E", "enable") +
								guideSep +
								guide("^F", "defer") +
								guideSep +
								guide("^D", "disable") +
								guideSep +
								guide("space", "cycle") +
								guideSep +
								guide("esc", "close"),
						);
						const result = frameModal({
							width: mw,
							maxHeight: terminalModalHeight(tui.terminal.rows),
							minHeight: MIN_MODAL_HEIGHT,
							header: [
								theme.fg(accent, theme.bold("🧰  Toolbox")),
								tabBar(),
								"",
								theme.fg("dim", "Search:"),
								...search.render(inner),
								"",
							],
							body,
							selectedBodyRange: pager.selectedRange({ start: selLine, end: selLine + 1 }),
							footer,
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
						if (pager.handleInput(data, keybindings, true)) {
							tui.requestRender?.();
							return;
						}
						if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
							list.handleInput?.(data);
							pager.followSelection();
						} else if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) {
							done(null);
							return;
						} else if (matchesKey(data, Key.shift(Key.tab))) {
							switchTab(-1);
						} else if (matchesKey(data, Key.tab)) {
							switchTab(1);
						} else if (matchesKey(data, Key.space)) {
							setSelected("cycle");
						} else if (matchesKey(data, Key.ctrl("e"))) {
							setSelected("enabled");
						} else if (matchesKey(data, Key.ctrl("f"))) {
							setSelected("deferred");
						} else if (matchesKey(data, Key.ctrl("d"))) {
							setSelected("disabled");
						} else {
							// Every other key goes to the search. Ctrl hotkeys never collide with typed text.
							search.handleInput?.(data);
							applyFilter(search.getValue?.() ?? "");
							pager.followSelection();
						}
						list.invalidate();
						tui.requestRender?.();
					},
				};
			},
			{ overlay: true, overlayOptions: modalOverlayOptions() },
		);
	}

	pi.registerCommand("toolbox", {
		description:
			"Set each tool to enabled, deferred or disabled. tab Tools/MCP, ↑↓ navigate, " +
			"ctrl+e/f/d enable/defer/disable, space cycle. " +
			"Headless: /toolbox enable|defer|disable <names>, /toolbox list [query]",
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();
			const verb = raw.split(/\s+/, 1)[0]?.toLowerCase();

			const VERBS: Record<string, ToolState> = {
				enable: "enabled",
				defer: "deferred",
				disable: "disabled",
			};
			const target = verb ? VERBS[verb] : undefined;
			if (verb && target) {
				const targets = parseTargets(raw.slice(verb.length).trim());
				if (!targets.length) {
					ctx.ui.notify(
						`/toolbox ${verb} needs a tool name, e.g. /toolbox ${verb} grep`,
						"warning",
					);
					return;
				}
				const rows = getRows();
				const msg = targets.map((t) => toggleTool(target, t, rows, ops)).join("\n");
				ctx.ui.notify(msg, "info");
				return;
			}

			if (verb === "list") {
				const query = raw.slice(verb.length).trim() || undefined;
				ctx.ui.notify(renderList(getRows(), ops.stateOf, query), "info");
				return;
			}

			if (typeof ctx.ui.custom === "function") {
				// SAFETY: The runtime command context satisfies showPicker's narrowed UI contract.
				await showPicker(ctx as unknown as Parameters<typeof showPicker>[0]);
			} else {
				ctx.ui.notify(renderList(getRows(), ops.stateOf), "info");
			}
		},
	});
}
