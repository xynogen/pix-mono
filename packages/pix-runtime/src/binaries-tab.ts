/**
 * binaries-tab.ts — the `/pix` Binaries tab: every catalogued binary, where it
 * resolved from, its version, and controls to install / set / clear a path.
 *
 * Pure view-controller over `binaries/*`; pix-command.ts owns the frame + tabs.
 */

import { Input, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { ensureTool, type ToolStatus } from "./binaries/ensure.ts";
import { listTools, type ToolLookup, toolVersion } from "./binaries/resolve.ts";
import { readBinaryStore, setBinaryChoice, syncBinaryStore } from "./binaries/store.ts";
import { type IconKey, icon } from "./icon-catalog.ts";
import { ListFilter } from "./list-filter.ts";

export interface TabTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export interface BinariesTabOptions {
	env: NodeJS.ProcessEnv;
	theme: TabTheme;
	requestRender(): void;
}

export interface TabView {
	header: string[];
	body: string[];
	selectedBodyLine?: number;
	/** Fixed context lines between the list and the keys: selected row, then the store file. */
	info: string[];
	/** Key/action guide pairs. */
	footer: Array<[string, string]>;
}

const STATE_ICON: Record<ToolLookup["state"], IconKey> = {
	ok: "status.ok",
	missing: "status.error",
	broken: "status.warn",
	unsupported: "status.pending",
};
const STATE_COLOR: Record<ToolLookup["state"], string> = {
	ok: "success",
	missing: "error",
	broken: "warning",
	unsupported: "muted",
};

export function describeStatus(s: ToolStatus): { text: string; color: string } {
	if (s.kind === "downloading")
		return {
			text: `downloading ${s.name} ${s.version}${s.size ? ` (${s.size})` : ""} from ${s.url}`,
			color: "accent",
		};
	if (s.kind === "installed")
		return {
			text: `installed ${s.name} ${s.version} → ${s.path}${s.verified ? " (sha256 verified)" : ""}`,
			color: "success",
		};
	return { text: `${s.name}: ${s.error}${s.hint ? ` — install: ${s.hint}` : ""}`, color: "error" };
}

/**
 * Shorten a path to `max` columns, keeping both ends (`C:\Program…\bash.exe`):
 * the root says where it lives, the tail says what it is.
 */
export function middleTruncate(text: string, max: number): string {
	if (text.length <= max) return text;
	if (max <= 1) return "…".slice(0, max);
	const tail = Math.ceil((max - 1) * 0.6);
	const head = max - 1 - tail;
	return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/** Rows needed on this OS first (alphabetical), then other-platform entries. */
function ordered(rows: ToolLookup[]): ToolLookup[] {
	const here = rows.filter((r) => r.state !== "unsupported");
	const other = rows.filter((r) => r.state === "unsupported");
	return [...here, ...other];
}

export function createBinariesTab(opts: BinariesTabOptions) {
	const { env, theme } = opts;
	let rows: ToolLookup[] = [];
	let selected = 0;
	let status: { text: string; color: string } | undefined;
	let storeError: string | undefined;
	let storePath = "";
	const versions = new Map<string, string | null>();
	const installing = new Set<string>();
	let editor: { name: string; input: Input } | undefined;
	/** Name/used-by filter. */
	const filter = new ListFilter();

	/** Rows that match the filter, in display order. */
	const shown = (): ToolLookup[] => rows.filter((r) => filter.matches(r.name, ...r.usedBy));

	const refresh = () => {
		const store = syncBinaryStore(env);
		storeError = store.error;
		storePath = store.path;
		rows = ordered(listTools({ env, store: readBinaryStore(env) }));
		selected = Math.min(selected, Math.max(0, shown().length - 1));
		for (const row of rows) {
			const key = `${row.name}\0${row.path ?? ""}`;
			if (row.state !== "ok" || !row.path || versions.has(key)) continue;
			versions.set(key, null);
			void toolVersion(row.name, row.path).then((v) => {
				versions.set(key, v ?? "");
				opts.requestRender();
			});
		}
	};

	const install = (row: ToolLookup) => {
		if (installing.has(row.name)) return;
		installing.add(row.name);
		void ensureTool(row.name, {
			env,
			onStatus: (s) => {
				status = describeStatus(s);
				opts.requestRender();
			},
		})
			.catch((err: unknown) => {
				if (status?.color !== "error")
					status = { text: err instanceof Error ? err.message : String(err), color: "error" };
			})
			.finally(() => {
				installing.delete(row.name);
				refresh();
				opts.requestRender();
			});
	};

	const save = (name: string, value: string | null) => {
		try {
			setBinaryChoice(name, value, env);
			status = value
				? { text: `${name} → ${value} (saved to binary.json)`, color: "success" }
				: { text: `${name} → automatic (saved to binary.json)`, color: "success" };
		} catch (err) {
			status = { text: err instanceof Error ? err.message : String(err), color: "error" };
		}
		refresh();
	};

	refresh();

	return {
		/** True while the path editor or the filter owns the keyboard (esc/tab must not leave the tab). */
		get editing(): boolean {
			return editor !== undefined || filter.typing;
		},

		/** True while the path editor is open. It keeps ↑↓ for itself. */
		get editingPath(): boolean {
			return editor !== undefined;
		},

		refresh,

		/** Esc with a kept filter clears it before it closes the overlay. True when it cleared one. */
		clearFilter(): boolean {
			if (!filter.clear()) return false;
			selected = 0;
			return true;
		},

		handleInput(data: string, keys: { up: boolean; down: boolean; enter: boolean }): boolean {
			if (editor) {
				editor.input.handleInput(data);
				return true;
			}
			const count = Math.max(1, shown().length);
			if (filter.typing && !keys.up && !keys.down) {
				filter.handleInput(data);
				selected = Math.min(selected, Math.max(0, shown().length - 1));
				return true;
			}
			// Other-platform rows are read-only: the cursor reaches them, the actions do not.
			const candidate = shown()[selected];
			const row = candidate?.state === "unsupported" ? undefined : candidate;
			// Moving on dismisses the last action's status so the detail line tracks the cursor.
			if (keys.up) {
				selected = (selected - 1 + count) % count;
				status = undefined;
			} else if (keys.down) {
				selected = (selected + 1) % count;
				status = undefined;
			} else if (keys.enter && row) {
				if (row.downloadable && row.state === "missing") install(row);
				else {
					refresh();
					status = { text: `re-checked ${row.name}`, color: "muted" };
				}
			} else if (matchesKey(data, "e") && row) {
				const input = new Input({ prompt: `${row.name} path: ` });
				input.focused = true;
				// setValue keeps the cursor at 0; paste the prefill as typed text so the
				// cursor sits at the end and ctrl+u clears the whole value.
				const prefill = row.choice ?? row.path ?? "";
				if (prefill) input.handleInput(`\x1b[200~${prefill}\x1b[201~`);
				input.onSubmit = (value) => {
					editor = undefined;
					save(row.name, value.trim() ? value : null);
					opts.requestRender();
				};
				input.onEscape = () => {
					editor = undefined;
					opts.requestRender();
				};
				editor = { name: row.name, input };
			} else if (matchesKey(data, "/")) {
				filter.open();
				selected = 0;
			} else if (matchesKey(data, "d") && row) save(row.name, null);
			else if (matchesKey(data, "r")) {
				versions.clear();
				refresh();
				status = { text: "re-checked all binaries", color: "muted" };
			} else return false;
			return true;
		},

		view(width: number): TabView {
			const nameW = Math.max(6, ...rows.map((r) => r.name.length));
			const iconW = Math.max(2, ...Object.values(STATE_ICON).map((key) => visibleWidth(icon(key))));
			// Frame border + padding take 4 columns; every row must fit on one line.
			const inner = Math.max(20, width - 4);
			const lead = 2 + iconW + 1 + nameW + 2; // cursor, glyph, name, gap
			const body: string[] = [];
			let selectedBodyLine: number | undefined;
			let otherHeader = false;
			const list = shown();
			for (let i = 0; i < list.length; i++) {
				const row = list[i] as ToolLookup;
				if (row.state === "unsupported" && !otherHeader) {
					otherHeader = true;
					body.push("", theme.fg("dim", "  Other platforms (not used here)"));
				}
				const sel = i === selected;
				const cursor = sel ? theme.fg("accent", "→") : " ";
				const soft = row.optional && row.state === "missing";
				// Color = priority: red/yellow rows need action, healthy rows read plain,
				// optional and other-platform rows recede.
				const quiet = soft || row.state === "unsupported";
				const glyph = quiet
					? theme.fg("dim", icon("status.pending"))
					: theme.fg(STATE_COLOR[row.state], icon(STATE_ICON[row.state]));
				const nameColor = sel
					? "accent"
					: quiet
						? "dim"
						: row.state === "ok"
							? "text"
							: STATE_COLOR[row.state];
				const name = theme.fg(nameColor, row.name.padEnd(nameW));
				const busy = installing.has(row.name);
				let detail: string;
				if (row.state === "ok") {
					const version = versions.get(`${row.name}\0${row.path ?? ""}`);
					const meta = [row.source === "user" ? "binary.json" : row.source, version || undefined]
						.filter(Boolean)
						.join(" · ");
					// Path gets what the metadata leaves; metadata is clipped last.
					const tag = ` · ${meta}`;
					const room = inner - lead;
					const pathRoom = Math.max(12, room - Math.min(tag.length, Math.max(0, room - 12)));
					detail = `${theme.fg("muted", middleTruncate(row.path ?? "", pathRoom))}${theme.fg("dim", tag)}`;
				} else if (row.state === "broken") {
					detail = row.error
						? theme.fg("warning", "blocked: binary.json is invalid")
						: `${theme.fg("warning", `${row.choice} not found`)}${theme.fg("dim", " · binary.json")}`;
				} else if (busy) {
					detail = theme.fg("accent", "installing…");
				} else if (soft) {
					detail = theme.fg("dim", `optional · ${row.hint}`);
				} else if (row.state === "missing") {
					detail = row.downloadable
						? `${theme.fg("error", "missing")}${theme.fg("dim", " · ")}${theme.fg("accent", "enter to install")}`
						: `${theme.fg("error", "missing")}${theme.fg("muted", ` · ${row.hint}`)}`;
				} else {
					detail = theme.fg("dim", row.hint);
				}
				if (sel) selectedBodyLine = body.length;
				const line = `${cursor} ${glyph}${" ".repeat(iconW - visibleWidth(glyph))} ${name}  ${detail}`;
				body.push(visibleWidth(line) > inner ? truncateToWidth(line, inner, "…") : line);
			}

			// CLI layout: search above the list; context (selected row, file) below it, next to the keys.
			const header: string[] = [filter.line(theme, inner, list.length, rows.length)];
			// One fixed detail line (editor › action status › selected row) so the
			// list never shifts as the cursor moves.
			const current = list[selected];
			const info: string[] = [];
			if (editor) info.push(editor.input.render(Math.max(10, inner))[0] ?? "");
			else if (status) info.push(theme.fg(status.color, truncateToWidth(status.text, inner, "…")));
			else if (current) {
				const users = current.usedBy.join(", ") || "binary.json";
				const other = current.state === "unsupported" ? " · not used on this OS" : "";
				info.push(
					truncateToWidth(
						`${theme.fg("text", current.name)} ${theme.fg("muted", `used by ${users}${other}`)}`,
						inner,
						"…",
					),
				);
			} else info.push("");
			if (storeError)
				info.push(theme.fg("error", `binary.json is invalid: ${storeError} — fix ${storePath}`));
			else {
				// Keep the file name (binary.json) visible: shorten the path's middle.
				const tail = " · unset = automatic";
				const text = `${middleTruncate(storePath, Math.max(12, inner - tail.length))}${tail}`;
				info.push(theme.fg("dim", truncateToWidth(text, inner, "…")));
			}

			if (list.length === 0) body.push(filter.noMatch(theme));
			const footer: Array<[string, string]> = editor
				? [
						["enter", "save (empty = automatic)"],
						["esc", "cancel"],
					]
				: filter.typing
					? filter.guides()
					: [
							["enter", "install/re-check"],
							...filter.guides(),
							["e", "set path"],
							["d", "automatic"],
							["r", "refresh"],
						];
			return { header, body, selectedBodyLine, info, footer };
		},

		/** Plain-text block for headless `/pix`. */
		summary(): string[] {
			return rows.map((r) => {
				const where =
					r.state === "ok"
						? `${r.path} (${r.source})`
						: r.state === "broken"
							? (r.error ?? `${r.choice} (broken)`)
							: r.state;
				return `  ${r.name}: ${where}`;
			});
		},
	};
}

export type BinariesTab = ReturnType<typeof createBinariesTab>;
