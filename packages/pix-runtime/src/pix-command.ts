/**
 * pix-command.ts — the `/pix` command: unified settings overlay for pix.json.
 *
 * Runtime owns this because it edits the shared document. Rows are declared
 * here against typed sections; persistence goes through `runtime.update()`.
 * Headless hosts get a notify summary instead of the overlay.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	Key,
	type KeybindingsManager,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { PixRuntime } from "./runtime.ts";
import type { DeepPartial, SectionHandle } from "./schema.ts";
import { collapseSection } from "./sections/collapse.ts";
import { compactionSection } from "./sections/compaction.ts";
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
		section: "Gate",
		label: "Guardrails",
		handle: gateSection,
		values: ["on", "off"],
		read: (v) => v.guardrails,
		patch: (guardrails) => ({ guardrails: guardrails as "on" | "off" }),
	}),
];

function buildSummary(runtime: PixRuntime): string {
	const lines = [`Pix Settings (${runtime.path})`, ""];
	let lastSection = "";
	for (const row of SETTINGS) {
		if (row.section !== lastSection) {
			if (lastSection) lines.push("");
			lines.push(`[${row.section}]`);
			lastSection = row.section;
		}
		const value = row.read(runtime.get(row.handle));
		const isDefault = value === row.read(row.handle.defaults);
		lines.push(`  ${row.label}: ${value}${isDefault ? "" : " *"}`);
	}
	return lines.join("\n");
}

export function registerPixCommand(pi: ExtensionAPI, runtime: PixRuntime): void {
	pi.registerCommand("pix", {
		description: "pix: open shared settings (edit pix.json)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			// Re-parse pix.json so section parsers remain the single validation source.
			await runtime.reload({ origin: "command", source: "pix" });
			// SAFETY: Runtime UI supports custom overlays beyond the published command context type.
			const ui = ctx.ui as unknown as {
				custom?: (f: unknown, opts?: unknown) => Promise<unknown>;
				notify(m: string, t?: "info" | "warning" | "error"): void;
			};

			if (typeof ui.custom !== "function") {
				ui.notify(buildSummary(runtime), "info");
				return;
			}

			await ui.custom(
				(
					tui: { requestRender(): void; terminal?: { rows?: number } },
					theme: {
						fg(c: string, t: string): string;
						bg(c: string, t: string): string;
						bold(t: string): string;
					},
					kb: KeybindingsManager,
					done: (v: null) => void,
				) => {
					const guide = (key: string, action: string) =>
						theme.fg("text", key) + theme.fg("muted", ` ${action}`);
					const guideSep = theme.fg("muted", " · ");
					let selected = 0;
					let bodyOffset = 0;
					let visibleBodyLines = 1;
					let maxBodyOffset = 0;
					let inspectingPage = false;

					const cycle = (direction: -1 | 1) => {
						const row = SETTINGS[selected];
						if (!row) return;
						// Functional updater: the runtime queue serializes writes, and the
						// callback sees the latest committed value — so rapid presses each
						// advance exactly one step instead of collapsing on a stale snapshot.
						type SettingsState = Record<string, unknown>;
						const step = (current: unknown): SettingsState => {
							const state: SettingsState =
								current !== null && typeof current === "object" ? { ...(current as object) } : {};
							const curVal = row.read(state);
							let cur = row.values.indexOf(curVal);
							// ponytail: unsupported custom values snap to section default on first change.
							if (cur === -1) {
								const def = row.read(row.handle.defaults);
								const defIdx = row.values.indexOf(def);
								cur = defIdx !== -1 ? defIdx - direction : -1;
							}
							const next = (cur + direction + row.values.length) % row.values.length;
							const val = row.values[next];
							if (val === undefined) return state;
							return { ...state, ...(row.patch(val) as object) };
						};
						// Re-render AFTER the commit lands; the synchronous render in
						// handleInput fires before the queued write and shows a stale value.
						void runtime
							.update(row.handle, step, { origin: "command", source: "pix" })
							.then(() => tui.requestRender())
							.catch(() => ui.notify(`pix: failed to update ${row.label}`, "error"));
					};
					const move = (direction: -1 | 1) => {
						selected = (selected + direction + SETTINGS.length) % SETTINGS.length;
						inspectingPage = false;
					};

					return {
						render: (width: number) => {
							const labelW = Math.max(...SETTINGS.map((r) => r.label.length));
							const body: string[] = [];
							const settingBodyLines: number[] = [];
							let lastSection = "";
							for (let i = 0; i < SETTINGS.length; i++) {
								const row = SETTINGS[i];
								if (!row) continue;
								if (row.section !== lastSection) {
									if (lastSection) body.push("");
									body.push(theme.fg("dim", `  ${row.section}`));
									lastSection = row.section;
								}
								const sel = i === selected;
								const cursor = sel ? theme.fg("accent", "→") : " ";
								const label = theme.fg(sel ? "accent" : "text", row.label.padEnd(labelW));
								const value = row.read(runtime.get(row.handle));
								const isDefault = value === row.read(row.handle.defaults);
								settingBodyLines[i] = body.length;
								body.push(`${cursor} ${label}  ${theme.fg(isDefault ? "dim" : "success", value)}`);
							}
							const result = frameModal({
								width,
								maxHeight: modalHeight(
									tui.terminal?.rows,
									runtime.get(prettySection).maxRenderHeight,
								),
								title: "Pix Settings",
								titleColor: (s: string) => theme.fg("accent", theme.bold(s)),
								header: [""],
								body,
								footer: [
									"",
									guide("←→", "change") +
										guideSep +
										guide("↑↓", "move") +
										guideSep +
										guide("PgUp/PgDn", "inspect") +
										guideSep +
										guide("esc", "close"),
								],
								bodyOffset,
								selectedBodyLine: inspectingPage ? undefined : settingBodyLines[selected],
								color: (s: string) => theme.fg("accent", s),
								bg: (s: string) => theme.bg("customMessageBg", s),
							});
							bodyOffset = result.bodyOffset;
							visibleBodyLines = Math.max(1, result.visibleBodyLines);
							maxBodyOffset = result.maxBodyOffset;
							return result.lines;
						},
						invalidate: () => {},
						handleInput: (data: string) => {
							const pageUp = kb?.matches(data, "tui.select.pageUp") || matchesKey(data, Key.pageUp);
							const pageDown =
								kb?.matches(data, "tui.select.pageDown") || matchesKey(data, Key.pageDown);
							if (pageUp || pageDown) {
								const direction = pageUp ? -1 : 1;
								bodyOffset = pageBodyOffset(bodyOffset, visibleBodyLines, maxBodyOffset, direction);
								inspectingPage = true;
								tui.requestRender();
								return;
							}
							// matchesKey handles both legacy bytes and Kitty CSI-u encodings
							// for letters and special keys alike — raw string compares like
							// `data === "k"` silently fail under the Kitty keyboard protocol.
							if (kb.matches(data, "tui.select.cancel")) {
								done(null);
								return;
							}
							if (kb.matches(data, "tui.select.up")) move(-1);
							else if (kb.matches(data, "tui.select.down")) move(1);
							else if (matchesKey(data, Key.left)) cycle(-1);
							else if (matchesKey(data, Key.right)) cycle(1);
							else return;
							tui.requestRender();
						},
					};
				},
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
		const selected = Math.min(body.length - 1, Math.max(0, opts.selectedBodyLine));
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
