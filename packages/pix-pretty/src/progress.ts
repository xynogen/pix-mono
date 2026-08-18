/**
 * pix-pretty/progress — modal progress overlay that owns input.
 *
 * A focused, non-dismissable spinner overlay. While open it holds input
 * ownership, so keystrokes are swallowed instead of reaching the editor —
 * this prevents out-of-order echo when a long-running command (e.g. an
 * update) competes with the TUI for the event loop.
 *
 * Usage:
 *   const p = openProgress(ctx.ui, "Updating Pi…");
 *   p.setLabel("Updating extensions…");   // live status line
 *   await doWork();
 *   p.close();                             // releases input, removes overlay
 */

import {
	frameModal,
	MIN_MODAL_HEIGHT,
	modalOverlayOptions,
	modalWidth,
	terminalModalHeight,
} from "./modal-frame.js";
import { SPINNER } from "./widget-format.js";

interface ProgressTheme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
}

interface ProgressComponent {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
}

export interface ProgressUI {
	custom<T>(
		cb: (
			tui: { requestRender(): void; terminal?: { rows?: number } },
			theme: ProgressTheme,
			kb: unknown,
			done: (v: T) => void,
		) => ProgressComponent,
		opts?: { overlay?: boolean; overlayOptions?: ReturnType<typeof modalOverlayOptions> },
	): Promise<T | undefined>;
}

export interface ProgressHandle {
	/** Update the status line shown under the title. */
	setLabel(label: string): void;
	/** Close the overlay and release input ownership. */
	close(): void;
}

// 120ms: smooth enough to read as motion, slow enough to barely touch the
// render queue. The overlay owns input so this isn't competing with echo.
const SPINNER_INTERVAL_MS = 120;

/**
 * Open a modal progress overlay. Returns a handle to update the label and
 * close it. The overlay swallows all keystrokes until closed.
 */
export function openProgress(ui: ProgressUI, title: string, accent = "accent"): ProgressHandle {
	let setLabelImpl: (label: string) => void = () => {};
	let closeImpl: () => void = () => {};

	ui.custom<void>(
		(tui, theme, _kb, done) => {
			let frame = 0;
			let labelValue = "Working…";

			const ticker = setInterval(() => {
				frame = (frame + 1) % SPINNER.length;
				tui.requestRender();
			}, SPINNER_INTERVAL_MS);

			setLabelImpl = (label: string) => {
				labelValue = label;
				tui.requestRender();
			};
			closeImpl = () => {
				clearInterval(ticker);
				done();
			};

			return {
				render: (w: number) => {
					const mw = modalWidth(w);
					return frameModal({
						width: mw,
						maxHeight: terminalModalHeight(tui.terminal?.rows),
						minHeight: MIN_MODAL_HEIGHT,
						header: [theme.fg(accent, theme.bold(title))],
						body: [`${theme.fg(accent, SPINNER[frame] ?? "")} ${theme.fg("muted", labelValue)}`],
						color: (s) => theme.fg(accent, s),
						bg: (s) => theme.bg("customMessageBg", s),
					}).lines;
				},
				invalidate: () => {},
				// Swallow every keystroke: a focused overlay owns input, so nothing
				// reaches the editor while the update runs.
				handleInput: () => {},
			};
		},
		{ overlay: true, overlayOptions: modalOverlayOptions() },
	);

	return {
		setLabel: (label) => setLabelImpl(label),
		close: () => closeImpl(),
	};
}
