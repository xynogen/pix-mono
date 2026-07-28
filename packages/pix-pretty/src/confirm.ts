/**
 * pix-pretty/confirm — reusable Yes/No confirmation overlay.
 *
 * Rounded modal frame (╭─╮╰─╯), solid bg, accent border — same visual style
 * as gate-overlay and pix-ask. Returns true on confirm, false on deny/timeout.
 */

import { type SelectItem, SelectList } from "@earendil-works/pi-tui";
import { frameLines, modalWidth, selectListTheme } from "./modal-frame.js";

// Minimal structural type for the `ctx.ui.custom` host call.
interface CustomTheme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
}

interface CustomComponent {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
	focused?: boolean;
}

export interface ConfirmUI {
	custom<T>(
		cb: (
			tui: { requestRender(): void },
			theme: CustomTheme,
			kb: unknown,
			done: (v: T) => void,
		) => CustomComponent,
		opts?: { overlay?: boolean },
	): Promise<T | undefined>;
}

export interface ConfirmOptions {
	/** Title shown bold at the top (e.g. "Update Pi & extensions?"). */
	title: string;
	/** Optional body lines rendered under the title. */
	body?: string[];
	/** Label for the confirm choice. Default "Yes". */
	confirmLabel?: string;
	/** Label for the deny choice. Default "No". */
	denyLabel?: string;
	/** Accent colour for border + selection. Default "accent". */
	accent?: string;
	/** Auto-cancel after this many ms (0 disables). Default 0. */
	timeoutMs?: number;
}

const SECOND_MS = 1000;
const COUNTDOWN_WARN_S = 5;

/**
 * Show a Yes/No overlay. Resolves true on confirm, false otherwise.
 */
export function confirmOverlay(ui: ConfirmUI, opts: ConfirmOptions): Promise<boolean> {
	const accent = opts.accent ?? "accent";
	const timeoutMs = opts.timeoutMs ?? 0;

	return new Promise((resolve) => {
		const controller = new AbortController();
		const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;

		ui.custom<boolean>(
			(tui, theme, _kb, done) => {
				let ticker: ReturnType<typeof setInterval> | undefined;
				let countdownLine: string | undefined;

				const choices: SelectItem[] = [
					{
						value: "yes",
						label: opts.confirmLabel ?? "Yes",
						description: "Proceed",
					},
					{
						value: "no",
						label: opts.denyLabel ?? "No",
						description: "Cancel",
					},
				];

				const selectList = new SelectList(choices, choices.length, selectListTheme(theme, accent));

				if (timeoutMs > 0) {
					const deadlineMs = Date.now() + timeoutMs;
					const updateCountdown = () => {
						const remaining = Math.max(0, Math.ceil((deadlineMs - Date.now()) / SECOND_MS));
						countdownLine =
							theme.fg("dim", "Auto-cancel in ") +
							theme.fg(remaining <= COUNTDOWN_WARN_S ? accent : "muted", `${remaining}s`);
					};
					updateCountdown();
					ticker = setInterval(() => {
						updateCountdown();
						tui.requestRender();
					}, SECOND_MS);
				}

				const finish = (value: boolean) => {
					if (timer !== undefined) clearTimeout(timer);
					if (ticker !== undefined) clearInterval(ticker);
					done(value);
				};

				selectList.onSelect = (item) => finish(item.value === "yes");
				selectList.onCancel = () => finish(false);
				controller.signal.addEventListener("abort", () => finish(false));

				return {
					render: (w: number) => {
						const mw = modalWidth(w);
						const inner = mw - 4;
						const lines: string[] = [];

						// Title
						lines.push(theme.fg(accent, theme.bold(opts.title)));

						// Body
						for (const line of opts.body ?? []) {
							lines.push(theme.fg("text", line));
						}

						// Divider
						lines.push(theme.fg("dim", "─".repeat(inner)));

						// Countdown
						if (countdownLine !== undefined) lines.push(countdownLine);

						// Select list
						for (const l of selectList.render(inner)) lines.push(l);

						lines.push("");
						lines.push(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"));

						return frameLines({
							width: mw,
							lines,
							color: (s) => theme.fg(accent, s),
							bg: (s) => theme.bg("customMessageBg", s),
							fg: (s) => theme.fg("text", s),
						});
					},
					invalidate: () => {},
					handleInput: (data: string) => {
						selectList.handleInput(data);
						tui.requestRender();
					},
				};
			},
			{ overlay: true },
		).then((result) => {
			if (timer !== undefined) clearTimeout(timer);
			resolve(result ?? false);
		});
	});
}
