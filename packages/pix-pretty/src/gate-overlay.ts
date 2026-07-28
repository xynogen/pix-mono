/**
 * pix-pretty/gate-overlay — shared permission dialog component.
 *
 * One component, two modes:
 *   "confirm" — SelectList only. Used by pix-gate for command gating.
 *   "sudo"    — SelectList → masked password input. Used by pix-sudo.
 *
 * Both modes share: rounded modal frame (╭─╮╰─╯), solid bg, accent border,
 * title, body lines, optional countdown. Same visual style as pix-ask.
 *
 * Design goals:
 *   - Pure function — no side effects, no global state.
 *   - Fully unit-testable: inject a mock `ui` to drive inputs deterministically.
 *   - Single source of truth for the overlay look across pix-gate and pix-sudo.
 */

import { Input, type SelectItem, SelectList, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { frameLines, modalWidth, selectListTheme } from "./modal-frame.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type OverlayAction = "approved" | "denied" | "timeout";

export interface OverlayResult {
	action: OverlayAction;
	/** Only present when action === "approved" and mode === "sudo". */
	password?: string;
	/** True when password validation exhausted every allowed attempt. */
	passwordAttemptsExhausted?: boolean;
}

export interface OverlayChoice {
	value: string;
	label: string;
	description: string;
}

interface BaseConfig {
	/** Accent colour token (e.g. "error", "warning", "accent"). Default "accent". */
	accent?: string;
	/** Title shown bold at the top. */
	title: string;
	/** Optional body lines under the title. */
	body?: string[];
	/**
	 * Auto-deny after this many ms of NO user input (dead-man's switch). The
	 * first keypress cancels the timer and the dialog then waits indefinitely.
	 * 0 or omitted = no timer (wait forever). Resolves with action "timeout".
	 */
	timeoutMs?: number;
	/**
	 * Choices shown in the SelectList.
	 * The choice whose value === approveValue counts as approval.
	 * Default: [{ value:"yes", label:"Allow" }, { value:"no", label:"Deny" }]
	 */
	choices?: OverlayChoice[];
	/** Which choice value means "approved". Default "yes". */
	approveValue?: string;
}

export interface ConfirmConfig extends BaseConfig {
	mode: "confirm";
}

export interface SudoConfig extends BaseConfig {
	mode: "sudo";
	/** Label for the password input hint. Default "Sudo password:" */
	passwordLabel?: string;
	/** Validate an entered password without closing the overlay. */
	validatePassword?: (password: string) => Promise<boolean>;
	/** Number of validation attempts before closing as exhausted. Default 3. */
	maxPasswordAttempts?: number;
}

export type OverlayConfig = ConfirmConfig | SudoConfig;

// Minimal structural types — no hard dep on a specific Pi context shape.
interface OverlayTheme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
}

interface OverlayTui {
	requestRender(): void;
}

interface OverlayComponent {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
	focused?: boolean;
}

export interface OverlayUI {
	custom<T>(
		cb: (
			tui: OverlayTui,
			theme: OverlayTheme,
			kb: unknown,
			done: (v: T) => void,
		) => OverlayComponent,
		opts?: { overlay?: boolean; overlayOptions?: { maxHeight?: number | `${number}%` } },
	): Promise<T | undefined>;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_CHOICES: OverlayChoice[] = [
	{ value: "yes", label: "Allow", description: "Proceed" },
	{ value: "no", label: "Deny", description: "Block" },
];

// ── Masked input (● per char) ─────────────────────────────────────────────────

class MaskedInput extends Input {
	override render(width: number): string[] {
		const real = this.getValue();
		this.setValue("●".repeat(real.length));
		const lines = super.render(width);
		this.setValue(real);
		return lines;
	}
}

// ── Renderer ──────────────────────────────────────────────────────────────────

/** Build body lines for the current stage, rendered into frameLines. */
function buildLines(opts: {
	theme: OverlayTheme;
	accent: string;
	config: OverlayConfig;
	stage: "select" | "password";
	selectList: SelectList;
	maskedInput: MaskedInput;
	countdownLine: string | undefined;
	passwordStatus: string | undefined;
	width: number;
}): string[] {
	const {
		theme,
		accent,
		config,
		stage,
		selectList,
		maskedInput,
		countdownLine,
		passwordStatus,
		width,
	} = opts;
	const inner = width - 4; // CHROME = 2 border + 2 padding
	const lines: string[] = [];

	// Title — wrap so a long reason/command isn't truncated by the frame.
	for (const t of wrapTextWithAnsi(config.title, inner)) {
		lines.push(theme.fg(accent, theme.bold(t)));
	}

	// Body — wrap each line so long commands wrap instead of getting cut off.
	for (const line of config.body ?? []) {
		const wrapped = line === "" ? [""] : wrapTextWithAnsi(line, inner);
		for (const w of wrapped) lines.push(theme.fg("text", w));
	}

	// Divider after title/body
	lines.push(theme.fg("dim", "─".repeat(inner)));

	// Countdown
	if (countdownLine !== undefined) lines.push(countdownLine);

	// Select or password stage
	if (stage === "select") {
		const listLines = selectList.render(inner);
		for (const l of listLines) lines.push(l);
		lines.push("");
		lines.push(theme.fg("dim", "↑↓ navigate • enter select • esc deny"));
	} else {
		const label = config.mode === "sudo" ? (config.passwordLabel ?? "Sudo password:") : "Password:";
		lines.push(theme.fg("muted", label));
		if (passwordStatus) lines.push(theme.fg("error", passwordStatus));
		const inputLines = maskedInput.render(inner);
		for (const l of inputLines) lines.push(l);
		lines.push("");
		lines.push(theme.fg("dim", "enter confirm • esc cancel"));
	}

	return lines;
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * Show a permission overlay and resolve the user's decision.
 *
 * @example — gate confirm
 * ```ts
 * const result = await showOverlay(ui, {
 *   mode: "confirm",
 *   title: "⚠️  DANGEROUS",
 *   body: ["rm -rf /tmp/work"],
 *   accent: "warning",
 *   timeoutMs: 30_000,
 *   choices: [
 *     { value: "yes", label: "Allow", description: "Run the command" },
 *     { value: "no",  label: "Deny",  description: "Block it"        },
 *   ],
 * });
 * ```
 *
 * @example — sudo prompt
 * ```ts
 * const result = await showOverlay(ui, {
 *   mode: "sudo",
 *   title: "🔐 ROOT COMMAND REQUEST",
 *   body: ["Intent: install package", "Command: apt install foo"],
 *   accent: "error",
 * });
 * if (result.action === "approved") runWithSudo(cmd, result.password!);
 * ```
 */
export function showOverlay(ui: OverlayUI, config: OverlayConfig): Promise<OverlayResult> {
	const accent = config.accent ?? "accent";
	const choices = config.choices ?? DEFAULT_CHOICES;
	const approveVal = config.approveValue ?? "yes";

	return new Promise((resolve) => {
		ui.custom<OverlayResult>(
			(tui, theme, _kb, done) => {
				type Stage = "select" | "password";
				let stage: Stage = "select";
				let countdownLine: string | undefined;
				let passwordStatus: string | undefined;
				let passwordAttempts = 0;
				let validatingPassword = false;

				// Dead-man's-switch timer: counts down only while untouched. The
				// first keypress cancels it (user is present → let them decide). If
				// it expires with no input, auto-deny so the agent isn't stuck.
				const timeoutMs = config.timeoutMs ?? 0;
				let remaining = Math.ceil(timeoutMs / 1000);
				let timer: ReturnType<typeof setInterval> | undefined;
				const cancelTimer = () => {
					if (timer) clearInterval(timer);
					timer = undefined;
					countdownLine = undefined;
				};

				// ── components ──────────────────────────────────────────────────
				const selectItems: SelectItem[] = choices.map((c) => ({
					value: c.value,
					label: c.label,
					description: c.description,
				}));

				const selectList = new SelectList(
					selectItems,
					selectItems.length,
					selectListTheme(theme, accent),
				);
				const maskedInput = new MaskedInput();

				// ── finish ───────────────────────────────────────────────────────
				const finish = (result: OverlayResult) => {
					cancelTimer();
					done(result);
				};

				// Arm the dead-man's switch (only when a timeout was requested).
				if (timeoutMs > 0) {
					countdownLine = theme.fg("dim", `auto-deny in ${remaining}s`);
					timer = setInterval(() => {
						remaining -= 1;
						if (remaining <= 0) {
							finish({ action: "timeout" });
							return;
						}
						countdownLine = theme.fg("dim", `auto-deny in ${remaining}s`);
						tui.requestRender();
					}, 1000);
				}

				// ── event wiring ─────────────────────────────────────────────────
				selectList.onSelect = (item) => {
					if (item.value !== approveVal) {
						finish({ action: "denied" });
					} else if (config.mode === "sudo") {
						stage = "password";
						tui.requestRender();
					} else {
						finish({ action: "approved" });
					}
				};
				selectList.onCancel = () => finish({ action: "denied" });

				maskedInput.onSubmit = async (pw) => {
					if (config.mode !== "sudo" || !config.validatePassword) {
						finish({ action: "approved", password: pw });
						return;
					}
					if (!pw.trim() || validatingPassword) return;

					validatingPassword = true;
					passwordStatus = "Checking password…";
					tui.requestRender();
					const valid = await config.validatePassword(pw);
					validatingPassword = false;
					if (valid) {
						finish({ action: "approved", password: pw });
						return;
					}

					passwordAttempts += 1;
					const maxAttempts = config.maxPasswordAttempts ?? 3;
					if (passwordAttempts >= maxAttempts) {
						finish({ action: "approved", password: pw, passwordAttemptsExhausted: true });
						return;
					}
					maskedInput.setValue("");
					passwordStatus = `Incorrect password — attempt ${passwordAttempts} of ${maxAttempts}`;
					tui.requestRender();
				};
				maskedInput.onEscape = () => {
					if (!validatingPassword) finish({ action: "denied" });
				};

				// ── component interface ──────────────────────────────────────────
				return {
					render: (w) => {
						const mw = modalWidth(w);
						const lines = buildLines({
							theme,
							accent,
							config,
							stage,
							selectList,
							maskedInput,
							countdownLine,
							passwordStatus,
							width: mw,
						});
						return frameLines({
							width: mw,
							lines,
							color: (s) => theme.fg(accent, s),
							bg: (s) => theme.bg("customMessageBg", s),
							fg: (s) => theme.fg("text", s),
						});
					},
					invalidate: () => {},
					handleInput: (data) => {
						cancelTimer(); // user is present — stop the auto-deny countdown
						if (validatingPassword) return;
						if (stage === "select") selectList.handleInput(data);
						else maskedInput.handleInput(data);
						tui.requestRender();
					},
				};
			},
			{ overlay: true, overlayOptions: { maxHeight: "80%" } },
		).then((result) => {
			resolve(result ?? { action: "denied" });
		});
	});
}
