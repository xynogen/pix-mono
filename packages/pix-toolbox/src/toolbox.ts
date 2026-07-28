/**
 * toolbox.ts — /toolbox command for user-driven tool gating
 *
 * Registers a `/toolbox` slash command that opens a TUI picker listing every
 * registered tool (built-in and MCP). The user can toggle tools on/off —
 * this controls which tools are described in the system prompt via
 * pi.setActiveTools(). All tools remain callable via function definitions
 * regardless of prompt visibility.
 *
 * Also supports headless usage:
 *   /toolbox enable <names>   — enable tool(s) by name
 *   /toolbox disable <names>  — disable tool(s) by name
 *   /toolbox list [query]     — text search (no picker)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	decodeKittyPrintable,
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
import { frameLines, modalWidth } from "@xynogen/pix-pretty/modal-frame";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Tools that can never be disabled — always prompt-visible. */
export const CORE_TOOLS: ReadonlySet<string> = new Set(["bash", "edit", "read", "write"]);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ToolRow {
	name: string;
	description: string;
	mcp: boolean;
	source?: string;
}

/** Callbacks for toggleTool / renderList — test seam. */
export interface ToggleOps {
	isActive: (name: string) => boolean;
	onActivate: (name: string) => boolean;
	onDeactivate: (name: string) => boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isMcpTool(info: ToolInfo): boolean {
	return /mcp/i.test(info.sourceInfo?.source ?? "");
}

export function buildRows(tools: ToolInfo[]): ToolRow[] {
	return tools
		.filter((t) => !CORE_TOOLS.has(t.name))
		.map((t) => ({
			name: t.name,
			description: firstSentence(t.description ?? ""),
			mcp: isMcpTool(t),
			source: t.sourceInfo?.source,
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
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

export function renderList(
	rows: ToolRow[],
	isActive: (name: string) => boolean,
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

	const lines = filtered.map((r) => {
		const status = isActive(r.name) ? "✓ active" : "# gated";
		const kind = r.mcp ? "MCP" : "tool";
		return `${status}  ${r.name}  [${kind}]  ${r.description}`;
	});
	return lines.join("\n");
}

export function toggleTool(
	action: "enable" | "disable",
	name: string,
	rows: ToolRow[],
	ops: ToggleOps,
): string {
	const row = rows.find((r) => r.name === name);
	if (!row) return `Unknown tool "${name}".`;

	if (action === "enable") {
		const did = ops.onActivate(name);
		return did ? `Enabled ${name} — now prompt-visible.` : `${name} is already active.`;
	}
	const did = ops.onDeactivate(name);
	return did ? `Disabled ${name} — hidden from prompt.` : `${name} is already gated.`;
}

// ─── Persistence ───────────────────────────────────────────────────────────

interface ToolboxState {
	enabledTools: string[];
}

function getStatePath(): string {
	return join(getAgentDir(), "toolbox.json");
}

// ─── State ──────────────────────────────────────────────────────────────────

function createState(pi: ExtensionAPI) {
	let enabledTools = new Set<string>();
	let initialized = false;

	function persist(): void {
		// Write to session so state survives branch navigation within a session
		try {
			pi.appendEntry<ToolboxState>("toolbox-config", {
				enabledTools: [...enabledTools],
			});
		} catch (err) {
			console.warn("toolbox: persist failed:", err);
		}
		// Write to disk so state survives across completely new sessions
		try {
			const sp = getStatePath();
			mkdirSync(dirname(sp), { recursive: true });
			writeFileSync(sp, JSON.stringify({ enabledTools: [...enabledTools] }, null, 2), "utf-8");
		} catch (err) {
			console.warn("toolbox: file persist failed:", err);
		}
	}

	/** Load previously persisted enabled tool names from disk. */
	function loadFromFile(): string[] | undefined {
		try {
			const sp = getStatePath();
			if (!existsSync(sp)) return undefined;
			const raw = JSON.parse(readFileSync(sp, "utf-8")) as ToolboxState;
			if (Array.isArray(raw?.enabledTools)) return raw.enabledTools;
		} catch {
			// File doesn't exist, is corrupt, or we're in a test env without getAgentDir
		}
		return undefined;
	}

	function restoreFromBranch(ctx: ExtensionContext): void {
		// Prefer file-based persistence (survives across sessions).
		// Fall back to session entries (survives branch navigation within a session).
		// Fall back to full enable (first run).
		const fileSaved = loadFromFile();
		if (fileSaved) {
			const validNames = new Set((pi.getAllTools() ?? []).map((t) => t.name));
			enabledTools = new Set(fileSaved.filter((n) => validNames.has(n) || CORE_TOOLS.has(n)));
			for (const ct of CORE_TOOLS) enabledTools.add(ct);
			initialized = true;
			apply();
			return;
		}

		// Fall back to plain init if sessionManager is unavailable (e.g. tests / headless)
		if (!ctx?.sessionManager) {
			ensureInit();
			return;
		}

		// getEntries() returns ALL entries in the session file — unlike getBranch()
		// which only walks ancestors. Custom entries appended via appendCustomEntry
		// are children of the leaf, not ancestors.
		const allEntries = ctx.sessionManager.getEntries();
		let saved: string[] | undefined;

		for (const entry of allEntries) {
			if (entry.type === "custom" && entry.customType === "toolbox-config") {
				const data = entry.data as ToolboxState | undefined;
				if (data?.enabledTools) saved = data.enabledTools;
			}
		}

		if (saved) {
			const validNames = new Set((pi.getAllTools() ?? []).map((t) => t.name));
			enabledTools = new Set(saved.filter((n) => validNames.has(n) || CORE_TOOLS.has(n)));
			for (const ct of CORE_TOOLS) enabledTools.add(ct);
		} else {
			const names = (pi.getAllTools() ?? []).map((t) => t.name);
			enabledTools = new Set(names);
		}
		initialized = true;
		apply();
		// Persist to disk on first init so future sessions pick it up
		persist();
	}

	function ensureInit(): void {
		if (initialized) return;
		let names: string[] = [];
		try {
			names = (pi.getAllTools() ?? []).map((t) => t.name);
		} catch (err) {
			console.warn("toolbox: getAllTools failed:", err);
		}
		if (!names.length) return;
		enabledTools = new Set(names);
		initialized = true;
		apply();
		persist();
	}

	function apply(): void {
		if (!initialized) return;
		try {
			pi.setActiveTools([...enabledTools]);
		} catch (err) {
			console.warn("toolbox: setActiveTools failed:", err);
		}
	}

	function isActive(name: string): boolean {
		return enabledTools.has(name);
	}

	function onActivate(name: string): boolean {
		if (!initialized) return false;
		if (enabledTools.has(name)) return false;
		enabledTools.add(name);
		apply();
		persist();
		return true;
	}

	function onDeactivate(name: string): boolean {
		if (!initialized) return false;
		if (CORE_TOOLS.has(name)) return false;
		const did = enabledTools.delete(name);
		if (did) {
			apply();
			persist();
		}
		return did;
	}

	return {
		ensureInit,
		restoreFromBranch,
		isActive,
		onActivate,
		onDeactivate,
	};
}

// ─── Registration ───────────────────────────────────────────────────────────

export default function registerToolbox(pi: ExtensionAPI): void {
	const state = createState(pi);

	// Defer init until tools are registered — session_start fires after all extensions load.
	// Try to restore persisted state; fall back to full init if no config found.
	pi.on("session_start", async (_event, ctx) => {
		state.restoreFromBranch(ctx);
	});

	// Re-restore when navigating branch history
	pi.on("session_tree", async (_event, ctx) => {
		state.restoreFromBranch(ctx);
	});

	function getRows(): ToolRow[] {
		try {
			return buildRows(pi.getAllTools() ?? []);
		} catch {
			return [];
		}
	}

	const ops: ToggleOps = {
		isActive: state.isActive,
		onActivate: state.onActivate,
		onDeactivate: state.onDeactivate,
	};

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
			(tui: TUI, theme: Theme, _kb: KeybindingsManager, done: (r: null) => void) => {
				const accent = "accent";
				const mute = (s: string) => theme.fg("muted", s);

				type RowState = "active" | "gated";
				const stateOf = (name: string): RowState => (ops.isActive(name) ? "active" : "gated");

				const labelFor = (r: ToolRow): string => {
					const active = stateOf(r.name) === "active";
					const marker = active ? " " : theme.fg("warning", "#");
					const name = active ? theme.fg("success", r.name) : theme.fg("dim", r.name);
					const kind = mute(`[${r.mcp ? "MCP" : "tool"}]`);
					return `${marker} ${name}  ${kind}`;
				};

				const descFor = (r: ToolRow): string => {
					const active = stateOf(r.name) === "active";
					const tag = active ? theme.fg("success", "active") : theme.fg("warning", "gated");
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
					Math.min(allItems.length, 14),
					{
						selectedPrefix: (t: string) => theme.fg(accent, t),
						selectedText: (t: string) => theme.fg(accent, t),
						description: (t: string) => t,
						scrollInfo: (t: string) => theme.fg("dim", t),
						noMatch: (t: string) => theme.fg("warning", t),
					},
					{
						minPrimaryColumnWidth: widest + 2,
						maxPrimaryColumnWidth: widest + 2,
					},
				);

				const internal = list as unknown as {
					items: SelectItem[];
					filteredItems: SelectItem[];
					selectedIndex: number;
				};

				const search = new Input();
				let statusText = "";

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

				const doToggle = (action: "enable" | "disable") => {
					const sel = list.getSelectedItem();
					if (!sel) return;
					const msg = toggleTool(action, sel.value, rows, ops);
					statusText = theme.fg("muted", msg);
					refreshLabels();
				};

				const flipSelected = () => {
					const sel = list.getSelectedItem();
					if (!sel) return;
					if (stateOf(sel.value) === "active") doToggle("disable");
					else doToggle("enable");
				};

				const applyFilter = (q: string) => {
					const query = q.trim();
					internal.filteredItems =
						query.length === 0
							? internal.items
							: fuzzyFilter(
									internal.items,
									query,
									(it: SelectItem) => `${it.value} ${it.description ?? ""}`,
								);
					internal.selectedIndex = 0;
					list.invalidate();
				};

				list.onSelect = () => done(null);
				list.onCancel = () => done(null);
				search.onEscape = () => done(null);

				return {
					render(w: number) {
						const mw = modalWidth(w);
						const inner = mw - 4; // CHROME = 2 border + 2 padding
						const lines: string[] = [
							theme.fg(accent, theme.bold("🧰  Toolbox")),
							theme.fg("muted", "Search:"),
							...search.render(inner),
							...list.render(inner),
						];
						if (statusText) lines.push(statusText);
						lines.push(
							theme.fg("dim", "↑↓ navigate · e enable · d disable · space toggle · esc close"),
						);
						return frameLines({
							width: mw,
							lines,
							color: (s) => theme.fg(accent, s),
							bg: (s) => theme.bg("customMessageBg", s),
							fg: (s) => theme.fg("text", s),
						});
					},
					invalidate() {
						list.invalidate();
						search.invalidate();
					},
					handleInput(data: string) {
						if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
							list.handleInput?.(data);
						} else if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) {
							done(null);
							return;
						} else if (matchesKey(data, Key.space) || matchesKey(data, Key.tab)) {
							flipSelected();
						} else {
							const printable = decodeKittyPrintable(data);
							if (printable !== undefined) {
								if (printable === "e") {
									doToggle("enable");
								} else if (printable === "d") {
									doToggle("disable");
								} else {
									search.handleInput?.(data);
									applyFilter(search.getValue?.() ?? "");
								}
							} else {
								search.handleInput?.(data);
								applyFilter(search.getValue?.() ?? "");
							}
						}
						list.invalidate();
						tui.requestRender?.();
					},
				};
			},
			{ overlay: true, overlayOptions: { anchor: "center", maxHeight: "80%" } },
		);
	}

	pi.registerCommand("toolbox", {
		description:
			"Toggle tools on/off. ↑↓ navigate, e/d enable/disable, space toggle. " +
			"Headless: /toolbox enable|disable <names>, /toolbox list [query]",
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();
			const verb = raw.split(/\s+/, 1)[0]?.toLowerCase();

			if (verb === "enable" || verb === "disable") {
				const targets = parseTargets(raw.slice(verb.length).trim());
				if (!targets.length) {
					ctx.ui.notify(
						`/toolbox ${verb} needs a tool name, e.g. /toolbox ${verb} grep`,
						"warning",
					);
					return;
				}
				const rows = getRows();
				const msg = targets.map((t) => toggleTool(verb, t, rows, ops)).join("\n");
				ctx.ui.notify(msg, "info");
				return;
			}

			if (verb === "list") {
				const query = raw.slice(verb.length).trim() || undefined;
				ctx.ui.notify(renderList(getRows(), ops.isActive, query), "info");
				return;
			}

			if (typeof ctx.ui.custom === "function") {
				await showPicker(ctx as unknown as Parameters<typeof showPicker>[0]);
			} else {
				ctx.ui.notify(renderList(getRows(), ops.isActive), "info");
			}
		},
	});
}
