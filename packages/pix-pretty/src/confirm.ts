/**
 * pix-pretty/confirm — reusable Yes/No confirmation overlay.
 *
 * Rounded modal frame (╭─╮╰─╯), solid bg, accent border — same visual style
 * as gate-overlay and pix-ask. Returns true on confirm, false on deny/timeout.
 */

import { type KeybindingsManager, type SelectItem, SelectList } from "@earendil-works/pi-tui";
import {
	frameModal,
	MIN_PERMISSION_MODAL_HEIGHT,
	ModalPager,
	modalOverlayOptions,
	modalWidth,
	selectListTheme,
	terminalModalHeight,
} from "./modal-frame.js";

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
			tui: { requestRender(): void; terminal?: { rows?: number } },
			theme: CustomTheme,
			kb: KeybindingsManager,
			done: (v: T) => void,
		) => CustomComponent,
		opts?: { overlay?: boolean; overlayOptions?: ReturnType<typeof modalOverlayOptions> },
	): Promise<T | undefined>;
}

export interface ConfirmOptions {
	/** Optional leading glyph for the title row, e.g. `icon("update")`. Rendered
	 *  as "<icon> <title>" so callers pass a resolved icon + plain text. */
	icon?: string;
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
			(tui, theme, kb, done) => {
				let ticker: ReturnType<typeof setInterval> | undefined;
				let countdownLine: string | undefined;
				const pager = new ModalPager();

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
							theme.fg("muted", "Auto-cancel in ") +
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
						const footer = [theme.fg("muted", "─".repeat(inner))];
						if (countdownLine !== undefined) footer.push(countdownLine);
						footer.push(...selectList.render(inner));
						footer.push("");
						footer.push(
							theme.fg("muted", "↑↓ choose • ←→/PgUp/PgDn inspect • enter select • esc cancel"),
						);

						const result = frameModal({
							width: mw,
							maxHeight: terminalModalHeight(tui.terminal?.rows),
							minHeight: MIN_PERMISSION_MODAL_HEIGHT,
							header: [
								theme.fg(accent, theme.bold(opts.icon ? `${opts.icon} ${opts.title}` : opts.title)),
							],
							body: (opts.body ?? []).map((line) => theme.fg("text", line)),
							footer,
							bodyOffset: pager.bodyOffset,
							color: (s) => theme.fg(accent, s),
							bg: (s) => theme.bg("customMessageBg", s),
							fg: (s) => theme.fg("text", s),
							overflowLine: ({ page, totalPages }) =>
								theme.fg("muted", `←→/PgUp/PgDn inspect • ${page}/${totalPages}`),
						});
						pager.sync(result);
						return result.lines;
					},
					invalidate: () => {},
					handleInput: (data: string) => {
						if (pager.handleInput(data, kb, true)) {
							tui.requestRender();
							return;
						}
						selectList.handleInput(data);
						tui.requestRender();
					},
				};
			},
			{ overlay: true, overlayOptions: modalOverlayOptions() },
		).then((result) => {
			if (timer !== undefined) clearTimeout(timer);
			resolve(result ?? false);
		});
	});
}
