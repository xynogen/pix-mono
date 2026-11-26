/**
 * pix-pretty/provider-picker — color-coded provider settings used by /web and /voice.
 *
 * `showSettingsPicker` shows the sectioned overview. `showProviderPicker` shows the tree:
 *
 * One row per provider: default dot, status (connected / no API key needed / N variables
 * not set), and an expandable list of shell variables with set state and an export
 * example. A provider row with a `model` also shows a model row when expanded.
 */

import {
	decodeKittyPrintable,
	Input,
	Key,
	type KeybindingsManager,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { getErrorMessage } from "@xynogen/pix-runtime/errors";
import { isSubTabKey, nextTab, renderSubTabBar, renderTabRule } from "@xynogen/pix-runtime/tab-bar";
import {
	frameModal,
	MIN_MODAL_HEIGHT,
	ModalPager,
	modalOverlayOptions,
	modalWidth,
	terminalModalHeight,
} from "./modal-frame.ts";

export interface ProviderPickerRow {
	id: string;
	configured: boolean;
	env: string[];
	/** Show "no API key needed" in place of "connected". */
	noKey?: boolean;
	/** Current model. When set, the expanded row shows an editable model line. */
	model?: string;
}

export interface ProviderPickerOptions {
	title: string;
	subtitle: string;
	/** Rows in display order. An `auto` row renders as a choice, not a provider. */
	rows: ProviderPickerRow[];
	current: string;
	/** Canonical name → legacy alias. Either one counts as set. */
	envAliases?: Record<string, string>;
	envExample?: (name: string) => string;
}

export type ProviderPickerAction =
	| { kind: "select"; id: string }
	| { kind: "model"; id: string; value: string };

interface PickerTheme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
}

export interface ProviderPickerUI {
	custom<T>(
		cb: (
			tui: { requestRender(): void; terminal?: { rows?: number } },
			theme: PickerTheme,
			keybindings: KeybindingsManager,
			done: (value: T) => void,
		) => {
			render(width: number): readonly string[];
			invalidate(): void;
			handleInput(data: string): void;
			dispose?(): void;
		},
		opts?: { overlay?: boolean; overlayOptions?: ReturnType<typeof modalOverlayOptions> },
	): Promise<T | undefined>;
}

type Node =
	| { kind: "provider"; row: ProviderPickerRow }
	| { kind: "env"; name: string }
	| { kind: "model"; row: ProviderPickerRow };

function defaultExample(name: string): string {
	return name.endsWith("_URL")
		? `export ${name}="https://example.com"`
		: `export ${name}="your-api-key"`;
}

/** Render the tree body. Exported for tests. */
export function renderProviderRows(
	opts: ProviderPickerOptions,
	theme: Pick<PickerTheme, "fg">,
	state: {
		cursor: number;
		expanded: Set<string>;
		field?: { render(width: number): readonly string[] };
	},
	width: number,
): { lines: string[]; nodes: Node[]; selected: { start: number; end: number } } {
	const aliases = opts.envAliases ?? {};
	const envIsSet = (name: string) => {
		const alias = aliases[name];
		return Boolean(process.env[name] || (alias && process.env[alias]));
	};
	const expandable = (row: ProviderPickerRow) =>
		row.model !== undefined || row.env.some((name) => !envIsSet(name));
	const nodes: Node[] = [];
	for (const row of opts.rows) {
		nodes.push({ kind: "provider", row });
		if (!state.expanded.has(row.id)) continue;
		for (const name of row.env) nodes.push({ kind: "env", name });
		if (row.model !== undefined) nodes.push({ kind: "model", row });
	}
	const mute = (value: string) => theme.fg("muted", value);
	const lines: string[] = [];
	let selected = { start: 0, end: 1 };
	nodes.forEach((node, index) => {
		const marker = index === state.cursor ? theme.fg("accent", "\u25B6") : " ";
		const start = lines.length;
		if (node.kind === "model") {
			const label = `${marker}     ${theme.fg("accent", "model")}:`;
			const field = index === state.cursor ? state.field : undefined;
			lines.push(
				field
					? `${label} ${field.render(Math.max(10, width - 15))[0] ?? ""}`
					: `${label} ${mute(node.row.model ?? "")}`,
			);
		} else if (node.kind === "env") {
			// ponytail: show only presence. Pix never reads or stores the secret value.
			const names = aliases[node.name] ? `${node.name} / ${aliases[node.name]}` : node.name;
			if (envIsSet(node.name)) {
				lines.push(
					`${marker}     ${theme.fg("accent", names)} ${theme.fg("success", "\u25CF set")}`,
				);
			} else {
				lines.push(
					`${marker}     ${theme.fg("accent", names)} ${mute("\u25CB not set")}`,
					`        ${theme.fg("warning", (opts.envExample ?? defaultExample)(node.name))}`,
				);
			}
		} else {
			const { id, configured, env, noKey } = node.row;
			const unset = env.filter((name) => !envIsSet(name)).length;
			const arrow = expandable(node.row) ? mute(state.expanded.has(id) ? "\u25BE" : "\u25B8") : " ";
			const isDefault = opts.current === id;
			const dot = isDefault ? theme.fg("accent", "\u25CF") : mute("\u25CB");
			const status =
				id === "auto"
					? mute("choice")
					: configured
						? theme.fg("success", noKey ? "no API key needed" : "connected")
						: theme.fg("warning", `${unset} variable${unset === 1 ? "" : "s"} not set`);
			const tail = isDefault ? mute(" \u00b7 default") : "";
			lines.push(`${marker} ${arrow} ${dot} ${theme.fg("accent", id)} ${status}${tail}`);
		}
		if (index === state.cursor) selected = { start, end: lines.length };
	});
	return { lines, nodes, selected };
}

export interface SettingsRow {
	key: string;
	section: string;
	label: string;
	value: string;
	/** Theme role for the value. Default `success`. */
	tone?: "success" | "warning" | "muted";
	/** Dim the label too: the row is turned off. The cursor still highlights it. */
	dim?: boolean;
	/** Enter edits `value` in a text field inside the row, not in a new dialog. */
	editable?: boolean;
	/**
	 * Enter opens a list under the row, inside the same modal. Typing filters it. With
	 * `editable`, the list also has a "type a value…" item that opens the text field.
	 */
	choices?: SettingsChoice[];
}

export interface SettingsChoice {
	value: string;
	/** Readable text shown in place of `value`, for example a device name. */
	label?: string;
	/** Muted text after the label, for example the language name. */
	hint?: string;
}

const CUSTOM_CHOICE = "\u0000custom";

/** Choices that match `query` by value or hint, case-insensitive. Exported for tests. */
export function filterChoices(choices: SettingsChoice[], query: string): SettingsChoice[] {
	const q = query.trim().toLowerCase();
	if (!q) return choices;
	return choices.filter((choice) =>
		[choice.value, choice.label, choice.hint].some((text) => text?.toLowerCase().includes(q)),
	);
}

export type SettingsAction = { key: string; value?: string };

/** Render the sectioned settings overview body. Exported for tests. */
export function renderSettingsRows(
	rows: SettingsRow[],
	theme: Pick<PickerTheme, "fg">,
	selected: number,
	field?: { render(width: number): readonly string[] },
	width = 80,
	list?: { choices: SettingsChoice[]; cursor: number; query: string; max?: number },
): { lines: string[]; rowLines: number[]; listLine?: number } {
	const labelWidth = Math.max(...rows.map((row) => row.label.length));
	const lines: string[] = [];
	const rowLines: number[] = [];
	let listLine: number | undefined;
	let section = "";
	rows.forEach((row, index) => {
		// An empty section (rows of one sub-tab) gets no heading.
		if (row.section !== section && row.section) {
			if (section) lines.push("");
			lines.push(theme.fg("dim", `  ${row.section}`));
			section = row.section;
		}
		const active = index === selected;
		rowLines[index] = lines.length;
		const labelRole = active ? "accent" : row.dim ? "dim" : "text";
		const label = `${active ? theme.fg("accent", "→") : " "} ${theme.fg(labelRole, row.label.padEnd(labelWidth))}  `;
		const editing = active ? field : undefined;
		const valueWidth = Math.max(10, width - labelWidth - 4);
		lines.push(
			editing
				? `${label}${editing.render(valueWidth)[0] ?? ""}`
				: // One line per row. A long value (a device name) wraps and breaks the cursor math.
					`${label}${theme.fg(row.tone ?? "success", truncateToWidth(row.value, valueWidth, "…"))}`,
		);
		if (!active || !list) return;
		// ponytail: a window of `max` items around the cursor. Add a scrollbar if lists grow past ~50.
		const max = list.max ?? 8;
		const start = Math.max(
			0,
			Math.min(list.cursor - Math.floor(max / 2), list.choices.length - max),
		);
		const pad = " ".repeat(labelWidth + 4);
		lines.push(`${pad}${theme.fg("muted", "filter:")} ${list.query}${theme.fg("accent", "█")}`);
		list.choices.slice(start, start + max).forEach((choice, offset) => {
			const on = start + offset === list.cursor;
			if (on) listLine = lines.length;
			// One line per choice, like the row value. A long device name must not wrap.
			// Cut plain text before the color, so the cut never splits a style.
			const room = Math.max(10, width - pad.length - 2);
			const name = truncateToWidth(choice.label ?? choice.value, room, "…");
			const left = room - visibleWidth(name);
			const hint = choice.hint && left > 3 ? truncateToWidth(`  ${choice.hint}`, left, "…") : "";
			const text =
				choice.value === CUSTOM_CHOICE
					? theme.fg(on ? "accent" : "dim", "type a value…")
					: `${theme.fg(on ? "accent" : "text", name)}${hint ? theme.fg("muted", hint) : ""}`;
			lines.push(`${pad}${on ? theme.fg("accent", "▸") : " "} ${text}`);
		});
		if (list.choices.length === 0) lines.push(`${pad}  ${theme.fg("muted", "no match")}`);
	});
	return { lines, rowLines, listLine };
}

export interface SettingsPickerOptions {
	title: string;
	/** Rows are read again after each action, so a changed value shows at once. */
	rows: () => SettingsRow[];
	/**
	 * Run a row action while the modal stays open. Return `"close"` to close it and
	 * resolve with the action, for example to open another view.
	 */
	onAction: (action: SettingsAction) => Promise<"close" | undefined> | "close" | undefined;
	/** Extra lines under the rows, for example a live level meter. Read on each render. */
	status?: () => string[];
	/** Called with a redraw function while the modal is open, for live status lines. */
	onMount?: (redraw: () => void) => () => void;
	/** Start row. */
	selected?: number;
	/**
	 * Show each row `section` as a sub-tab (`` ` `` switches) instead of a heading in one list.
	 * Off by default; one section shows no tab bar.
	 */
	sectionTabs?: boolean;
}

/**
 * Show the sectioned settings overview, or one section per sub-tab with `sectionTabs`.
 * It stays open until esc, or until
 * `onAction` returns `"close"`. For an `editable` row, enter opens a text field in
 * the row. Resolves with the closing action, or null on escape.
 */
export async function showSettingsPicker(
	ui: ProviderPickerUI,
	opts: SettingsPickerOptions,
): Promise<SettingsAction | null> {
	const result = await ui.custom<SettingsAction | null>(
		(tui, theme, keybindings, done) => {
			let all = opts.rows();
			const sectionsOf = (list: SettingsRow[]) => [...new Set(list.map((row) => row.section))];
			// Start on the section of the requested row, so a reopened panel keeps its place.
			let tab = opts.sectionTabs ? (all[opts.selected ?? 0]?.section ?? all[0]?.section ?? "") : "";
			const visible = () => (tab ? all.filter((row) => row.section === tab) : all);
			let rows = visible();
			let selected = Math.max(
				0,
				Math.min(rows.indexOf(all[opts.selected ?? 0] as SettingsRow), rows.length - 1),
			);
			let field: Input | undefined;
			let list: { row: SettingsRow; query: string; cursor: number } | undefined;
			let busy = false;
			let error = "";
			const redraw = () => tui.requestRender();
			const unmount = opts.onMount?.(redraw);
			const close = (value: SettingsAction | null) => {
				unmount?.();
				done(value);
			};
			const run = async (action: SettingsAction) => {
				busy = true;
				error = "";
				try {
					if ((await opts.onAction(action)) === "close") return close(action);
				} catch (cause) {
					error = getErrorMessage(cause);
				}
				busy = false;
				all = opts.rows();
				if (tab && !sectionsOf(all).includes(tab)) tab = all[0]?.section ?? "";
				rows = visible();
				selected = Math.min(selected, Math.max(0, rows.length - 1));
				redraw();
			};
			const edit = (row: SettingsRow) => {
				const input = new Input({ prompt: "" });
				input.setValue(row.value);
				input.focused = true;
				input.onEscape = () => {
					field = undefined;
				};
				input.onSubmit = (raw) => {
					const value = raw.trim();
					field = undefined;
					if (value && value !== row.value) void run({ key: row.key, value });
				};
				field = input;
			};
			const listChoices = () => {
				if (!list) return [];
				const shown = filterChoices(list.row.choices ?? [], list.query);
				return list.row.editable ? [...shown, { value: CUSTOM_CHOICE }] : shown;
			};
			const openList = (row: SettingsRow) => {
				const index = (row.choices ?? []).findIndex((choice) => choice.value === row.value);
				list = { row, query: "", cursor: Math.max(0, index) };
			};
			const listInput = (data: string) => {
				if (!list) return;
				const choices = listChoices();
				if (keybindings.matches(data, "tui.select.cancel")) list = undefined;
				else if (keybindings.matches(data, "tui.select.up"))
					list.cursor = (list.cursor - 1 + choices.length) % Math.max(1, choices.length);
				else if (keybindings.matches(data, "tui.select.down"))
					list.cursor = (list.cursor + 1) % Math.max(1, choices.length);
				else if (matchesKey(data, Key.enter)) {
					const choice = choices[list.cursor];
					const { row, query } = list;
					list = undefined;
					if (!choice) return;
					if (choice.value === CUSTOM_CHOICE) {
						edit(row);
						if (query) field?.setValue(query);
					} else if (choice.value !== row.value) void run({ key: row.key, value: choice.value });
				} else if (matchesKey(data, Key.backspace)) {
					list.query = list.query.slice(0, -1);
					list.cursor = 0;
				} else {
					const char = decodeKittyPrintable(data) ?? data;
					if (char.length !== 1 || char < " ") return;
					list.query += char;
					list.cursor = 0;
				}
				redraw();
			};
			return {
				render(width: number) {
					const mw = modalWidth(width);
					const tabs = tab ? sectionsOf(all) : [];
					const body = renderSettingsRows(
						tabs.length > 1 ? rows.map((row) => ({ ...row, section: "" })) : rows,
						theme,
						selected,
						field,
						mw - 4,
						list && { choices: listChoices(), cursor: list.cursor, query: list.query },
					);
					const status = opts.status?.() ?? [];
					if (error) status.push(theme.fg("error", error));
					if (status.length) body.lines.push("", ...status);
					return frameModal({
						width: mw,
						maxHeight: terminalModalHeight(tui.terminal?.rows),
						minHeight: MIN_MODAL_HEIGHT,
						title: opts.title,
						titleColor: (text) => theme.fg("accent", theme.bold(text)),
						header:
							tabs.length > 1
								? [renderSubTabBar(tabs, tab, theme, mw - 4), renderTabRule(theme, mw - 4)]
								: [""],
						body: body.lines,
						footer: [
							"",
							theme.fg(
								"muted",
								field
									? "enter save · esc cancel"
									: list
										? "type to filter · ↑↓ move · enter pick · esc cancel"
										: `↑↓ move · space/enter${all.some((row) => row.choices?.length) ? "/←→" : ""} change${tabs.length > 1 ? " · ` sub-tab" : ""} · esc close`,
							),
						],
						selectedBodyLine: body.listLine ?? body.rowLines[selected],
						color: (text) => theme.fg("accent", text),
						bg: (text) => theme.bg("customMessageBg", text),
					}).lines;
				},
				invalidate() {},
				dispose: unmount,
				handleInput(data: string) {
					if (field) {
						field.handleInput(data);
						return redraw();
					}
					if (list) return listInput(data);
					if (keybindings.matches(data, "tui.select.cancel")) return close(null);
					if (busy) return;
					if (tab && isSubTabKey(data)) {
						tab = nextTab(sectionsOf(all), tab);
						rows = visible();
						selected = 0;
						return redraw();
					}
					const row = rows[selected];
					// Standard /pix keys: enter or space acts on the row; ←→ step through its choices.
					if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
						if (!row) return;
						if (row.choices?.length) openList(row);
						else if (row.editable) edit(row);
						else void run({ key: row.key });
						return redraw();
					}
					if (row?.choices?.length && (matchesKey(data, Key.left) || matchesKey(data, Key.right))) {
						const at = row.choices.findIndex((choice) => choice.value === row.value);
						const step = matchesKey(data, Key.left) ? -1 : 1;
						const next = row.choices[(at + step + row.choices.length) % row.choices.length];
						if (next && next.value !== row.value) void run({ key: row.key, value: next.value });
						return redraw();
					}
					if (keybindings.matches(data, "tui.select.up"))
						selected = (selected - 1 + rows.length) % rows.length;
					else if (keybindings.matches(data, "tui.select.down"))
						selected = (selected + 1) % rows.length;
					else return;
					redraw();
				},
			};
		},
		{ overlay: true, overlayOptions: modalOverlayOptions() },
	);
	return result ?? null;
}

/** Show the provider tree. Resolves the chosen action, or null on escape. */
export async function showProviderPicker(
	ui: ProviderPickerUI,
	opts: ProviderPickerOptions,
): Promise<ProviderPickerAction | null> {
	const result = await ui.custom<ProviderPickerAction | null>(
		(tui, theme, keybindings, done) => {
			const guide = (key: string, action: string) =>
				theme.fg("text", key) + theme.fg("muted", ` ${action}`);
			const sep = theme.fg("muted", " \u00b7 ");
			const expanded = new Set<string>();
			const pager = new ModalPager();
			let field: Input | undefined;
			let nodes = renderProviderRows(opts, theme, { cursor: -1, expanded }, 80).nodes;
			let cursor = Math.max(
				0,
				nodes.findIndex((node) => node.kind === "provider" && node.row.id === opts.current),
			);

			const openField = (row: ProviderPickerRow) => {
				const input = new Input({ prompt: "" });
				input.setValue(row.model ?? "");
				input.focused = true;
				input.onEscape = () => {
					field = undefined;
				};
				input.onSubmit = (raw) => {
					const value = raw.trim();
					field = undefined;
					if (value) done({ kind: "model", id: row.id, value });
				};
				field = input;
			};

			const select = () => {
				const node = nodes[cursor];
				if (node?.kind === "provider") return done({ kind: "select", id: node.row.id });
				if (node?.kind !== "model") return;
				openField(node.row);
			};

			const toggle = () => {
				const node = nodes[cursor];
				if (node?.kind !== "provider") return;
				if (expanded.has(node.row.id)) expanded.delete(node.row.id);
				else expanded.add(node.row.id);
				nodes = renderProviderRows(opts, theme, { cursor, expanded }, 80).nodes;
			};

			return {
				render(width: number) {
					const mw = modalWidth(width);
					const body = renderProviderRows(opts, theme, { cursor, expanded, field }, mw - 4);
					nodes = body.nodes;
					const frame = frameModal({
						width: mw,
						maxHeight: terminalModalHeight(tui.terminal?.rows),
						minHeight: MIN_MODAL_HEIGHT,
						header: [
							theme.fg("accent", theme.bold(opts.title)),
							theme.fg("dim", opts.subtitle),
							"",
						],
						body: body.lines,
						selectedBodyRange: pager.selectedRange(body.selected),
						footer: [
							"",
							field
								? guide("enter", "submit") + sep + guide("esc", "cancel")
								: guide("↑↓", "move") +
									sep +
									guide("enter", "set default") +
									sep +
									guide("space", "expand") +
									sep +
									guide("esc", "close"),
						],
						bodyOffset: pager.bodyOffset,
						color: (value) => theme.fg("accent", value),
						bg: (value) => theme.bg("customMessageBg", value),
						fg: (value) => theme.fg("text", value),
					});
					pager.sync(frame);
					return frame.lines;
				},
				invalidate() {},
				handleInput(data: string) {
					if (field) field.handleInput(data);
					else if (pager.handleInput(data, keybindings, true)) {
						// paged
					} else if (matchesKey(data, Key.escape)) return done(null);
					else if (matchesKey(data, Key.enter)) return select();
					else if (matchesKey(data, Key.space)) toggle();
					else if (matchesKey(data, Key.up) || keybindings.matches(data, "tui.select.up")) {
						cursor = Math.max(0, cursor - 1);
						pager.followSelection();
					} else if (matchesKey(data, Key.down) || keybindings.matches(data, "tui.select.down")) {
						cursor = Math.min(nodes.length - 1, cursor + 1);
						pager.followSelection();
					}
					tui.requestRender();
				},
			};
		},
		{ overlay: true, overlayOptions: modalOverlayOptions() },
	);
	return result ?? null;
}
