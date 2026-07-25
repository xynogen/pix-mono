/**
 * opt.ts — the single `/optimizer` command: an interactive overlay that fronts
 * every optimizer tool.
 *
 * caveman / rtk / toon / ponytail each register their own lifecycle hooks but
 * expose an OptimizerHandle (name · values · current() · run()). This overlay
 * renders one SettingsList row per tool:
 *
 *   ↑↓  move between tools
 *   ←→  cycle the selected tool's value (off → level/on → …)
 *   esc close
 *
 * Selecting a value calls the handle's run(), which persists + repaints the
 * shared status cell. There is no text-arg form — the overlay is the only UI.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { frameLines } from "@xynogen/pix-pretty/modal-frame";
import type { OptimizerHandle, OptimizerStatus, OptimizerTool } from "./status.ts";
import { toolIcon } from "./status.ts";

/** Min/max content width for the overlay box (excludes 4 cols of chrome). */
const MIN_CONTENT = 28;
const MAX_CONTENT = 60;

/** Fixed render order — matches the status-bar cell. */
const TOOL_ORDER: readonly OptimizerTool[] = ["caveman", "rtk", "toon", "ponytail"];

/** Strip the leading "name [args] — " prefix from a handle's help string. */
function helpSummary(help: string): string {
	const dash = help.indexOf("—");
	return dash === -1 ? help : help.slice(dash + 1).trim();
}

/** Filled / empty bar segment glyphs. */
const BAR_FILLED = "▰";
const BAR_EMPTY = "▱";

/**
 * Render an intensity bar for a tool's current value. One segment per
 * non-"off" step in `values`; segments up to and including the current value's
 * position are filled, the rest empty. "off" → all empty.
 *
 *   ponytail [off,lite,full,ultra]: off=▱▱▱ lite=▰▱▱ full=▰▰▱ ultra=▰▰▰
 *   rtk      [off,on]:               off=▱   on=▰
 *
 * Pure + exported for tests.
 */
export function levelBar(current: string, values: readonly string[]): string {
	const segments = values.length - 1; // exclude "off"
	if (segments < 1) return "";
	const idx = values.indexOf(current); // 0 = off → 0 filled
	const filled = Math.max(0, idx);
	return BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(segments - filled);
}

/** Plain-text status fallback when there's no custom-UI host (headless/tests). */
export function buildOptHelp(handles: Record<OptimizerTool, OptimizerHandle>): string {
	const lines = TOOL_ORDER.map(
		(n) => `  ${n}: ${handles[n].current()}  — ${helpSummary(handles[n].help)}`,
	);
	return ["pix-optimizer — token tools", "", ...lines].join("\n");
}

export function registerOptCommand(
	pi: ExtensionAPI,
	handles: Record<OptimizerTool, OptimizerHandle>,
	_status: OptimizerStatus,
): void {
	pi.registerCommand("optimizer", {
		description: "pix-optimizer: caveman / rtk / toon / ponytail tools",
		handler: async (_args, ctx) => {
			const ui = ctx.ui as unknown as {
				theme: {
					fg(c: string, t: string): string;
					bg(c: string, t: string): string;
					bold(t: string): string;
				};
				custom?: <T>(
					f: unknown,
					opts?: {
						overlay?: boolean;
						overlayOptions?: {
							anchor?: string;
							width?: number;
							maxHeight?: string;
						};
					},
				) => Promise<T>;
				notify(m: string, t?: "info" | "warning" | "error"): void;
			};

			// No custom-UI host (headless/tests) → plain status text.
			if (typeof ui.custom !== "function") {
				ui.notify(buildOptHelp(handles), "info");
				return;
			}

			const nameWidth = Math.max(...TOOL_ORDER.map((n) => n.length));
			// Widest value across all tools, so value columns line up.
			const valueWidth = Math.max(
				...TOOL_ORDER.flatMap((t) => handles[t].values.map((v) => v.length)),
			);
			// Fixed content width: widest help summary (the box's longest line) vs
			// title, clamped. Fixed so the box doesn't resize as values/selection
			// change and so the overlay can be centered at exactly this width.
			const widestHelp = Math.max(
				...TOOL_ORDER.map((t) => helpSummary(handles[t].help).length),
				"󱎫  Optimizer".length,
			);
			const content = Math.min(MAX_CONTENT, Math.max(MIN_CONTENT, widestHelp));
			const boxW = content + 4; // + chrome (2 border + 2 padding)

			await ui.custom<null>(
				(
					tui: { requestRender(): void },
					theme: typeof ui.theme,
					_kb: unknown,
					done: (v: null) => void,
				) => {
					let selected = 0;

					const cycle = (direction: -1 | 1) => {
						const tool = TOOL_ORDER[selected] as OptimizerTool;
						const values = handles[tool].values;
						const cur = values.indexOf(handles[tool].current());
						const next = (cur + direction + values.length) % values.length;
						handles[tool].run(values[next] ?? "", ctx);
					};

					const move = (direction: -1 | 1) => {
						selected = (selected + direction + TOOL_ORDER.length) % TOOL_ORDER.length;
					};

					return {
						render: () => {
							const rows = TOOL_ORDER.map((tool, i) => {
								const on = handles[tool].current() !== "off";
								const sel = i === selected;
								const cursor = sel ? theme.fg("accent", "→") : " ";
								const glyph = theme.fg(on ? "accent" : "dim", toolIcon(tool));
								const name = theme.fg(
									sel ? "accent" : on ? "text" : "muted",
									tool.padEnd(nameWidth),
								);
								const cur = handles[tool].current();
								const value = theme.fg(on ? "success" : "dim", cur.padEnd(valueWidth));
								const bar = theme.fg(on ? "accent" : "dim", levelBar(cur, handles[tool].values));
								return `${cursor} ${glyph}  ${name}  ${value}  ${bar}`;
							});
							const lines = [
								theme.fg("accent", theme.bold("󱎫  Optimizer")),
								"",
								...rows,
								"",
								theme.fg("dim", helpSummary(handles[TOOL_ORDER[selected] as OptimizerTool].help)),
								"",
								theme.fg("dim", "←→ change · ↑↓ move · esc close"),
							];
							return frameLines({
								width: boxW,
								lines,
								color: (s) => theme.fg("accent", s),
								bg: (s) => theme.bg("customMessageBg", s),
							});
						},
						invalidate: () => {},
						handleInput: (data: string) => {
							if (data === "k" || matchesKey(data, "up")) move(-1);
							else if (data === "j" || matchesKey(data, "down")) move(1);
							else if (data === "h" || matchesKey(data, "left")) cycle(-1);
							else if (data === "l" || matchesKey(data, "right") || data === " " || data === "\r")
								cycle(1);
							else if (matchesKey(data, "escape") || data === "q") {
								done(null);
								return;
							} else return;
							tui.requestRender();
						},
					};
				},
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: boxW, maxHeight: "80%" },
				},
			);
		},
	});
}
