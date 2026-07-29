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
import { gateSection } from "./sections/gate.ts";
import { prettySection } from "./sections/pretty.ts";

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
		section: "Gate",
		label: "Guardrails",
		handle: gateSection,
		values: ["on", "off"],
		read: (v) => v.guardrails,
		patch: (guardrails) => ({ guardrails: guardrails as "on" | "off" }),
	}),
];

function buildSummary(runtime: PixRuntime): string {
	const lines = [`pix settings (${runtime.path})`, ""];
	let lastSection = "";
	for (const row of SETTINGS) {
		if (row.section !== lastSection) {
			if (lastSection) lines.push("");
			lines.push(`[${row.section}]`);
			lastSection = row.section;
		}
		const value = row.read(runtime.get(row.handle));
		const isDefault = value === row.values[0];
		lines.push(`  ${row.label}: ${value}${isDefault ? "" : " *"}`);
	}
	return lines.join("\n");
}

export function registerPixCommand(pi: ExtensionAPI, runtime: PixRuntime): void {
	pi.registerCommand("pix", {
		description: "pix: open shared settings (edit pix.json)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const ui = ctx.ui as unknown as {
				custom?: (f: unknown, opts?: unknown) => Promise<unknown>;
				notify(m: string, t?: "info" | "warning" | "error"): void;
			};

			if (typeof ui.custom !== "function") {
				ui.notify(buildSummary(runtime), "info");
				return;
			}

			const boxW = 52;
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
					let selected = 0;
					let bodyOffset = 0;
					let visibleBodyLines = 1;
					let maxBodyOffset = 0;
					let inspectingPage = false;

					const cycle = (direction: -1 | 1) => {
						const row = SETTINGS[selected];
						if (!row) return;
						const cur = row.values.indexOf(row.read(runtime.get(row.handle)));
						const next = (cur + direction + row.values.length) % row.values.length;
						const val = row.values[next];
						if (val === undefined) return;
						void runtime.update(row.handle, row.patch(val), { origin: "command", source: "pix" });
					};
					const move = (direction: -1 | 1) => {
						selected = (selected + direction + SETTINGS.length) % SETTINGS.length;
						inspectingPage = false;
					};

					return {
						render: () => {
							const labelW = Math.max(...SETTINGS.map((r) => r.label.length));
							const body: string[] = [];
							const settingBodyLines: number[] = [];
							let lastSection = "";
							for (let i = 0; i < SETTINGS.length; i++) {
								const row = SETTINGS[i]!;
								if (row.section !== lastSection) {
									if (lastSection) body.push("");
									body.push(theme.fg("dim", `  ${row.section}`));
									lastSection = row.section;
								}
								const sel = i === selected;
								const cursor = sel ? theme.fg("accent", "→") : " ";
								const label = theme.fg(sel ? "accent" : "text", row.label.padEnd(labelW));
								const value = row.read(runtime.get(row.handle));
								const isDefault = value === row.values[0];
								settingBodyLines[i] = body.length;
								body.push(`${cursor} ${label}  ${theme.fg(isDefault ? "dim" : "success", value)}`);
							}
							const result = frameModal({
								width: boxW,
								maxHeight: modalHeight(tui.terminal?.rows),
								header: [theme.fg("accent", theme.bold("  pix settings")), ""],
								body,
								footer: [
									"",
									theme.fg("dim", "←→ change · ↑↓ move · PgUp/PgDn inspect · esc close"),
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
							if (matchesKey(data, "k") || matchesKey(data, "up")) move(-1);
							else if (matchesKey(data, "j") || matchesKey(data, "down")) move(1);
							else if (matchesKey(data, "h") || matchesKey(data, "left")) cycle(-1);
							else if (
								matchesKey(data, "l") ||
								matchesKey(data, "right") ||
								matchesKey(data, "space") ||
								matchesKey(data, "enter")
							)
								cycle(1);
							else if (matchesKey(data, "escape") || matchesKey(data, "q")) {
								done(null);
								return;
							} else return;
							tui.requestRender();
						},
					};
				},
				{ overlay: true, overlayOptions: { anchor: "center", width: boxW, maxHeight: "80%" } },
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
}

interface RuntimeModalResult {
	lines: string[];
	bodyOffset: number;
	visibleBodyLines: number;
	maxBodyOffset: number;
}

function modalHeight(rows = 24): number {
	const safe = Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : 24;
	return Math.max(1, Math.min(safe, Math.floor(safe * 0.8)));
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
	opts: Pick<RuntimeModalOptions, "color" | "bg">,
): string[] {
	const bg = opts.bg ?? ((s: string) => s);
	const inner = Math.max(1, width - 4);
	const dashes = "─".repeat(width - 2);
	const SENTINEL = "\x00";
	const bgOpen = bg(SENTINEL).split(SENTINEL)[0] ?? "";
	const reassert = (s: string): string =>
		bgOpen
			? s.replace(/\x1b\[([0-9;]*)m/g, (seq, p: string) =>
					p === "0" || p.split(";").includes("49") ? `${seq}${bgOpen}` : seq,
				)
			: s;
	const row = (content: string): string => {
		const fitted = truncateToWidth(content, inner, "…");
		const padded = fitted + " ".repeat(Math.max(0, inner - visibleWidth(fitted)));
		return bg(`${opts.color("│")} ${reassert(padded)} ${opts.color("│")}`);
	};
	return [bg(opts.color(`╭${dashes}╮`)), ...lines.map(row), bg(opts.color(`╰${dashes}╯`))];
}
