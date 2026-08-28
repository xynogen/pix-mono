/**
 * pix-pretty/gate-overlay — shared permission dialog component.
 *
 * One component, two modes:
 *   "confirm" — SelectList only. Used by pix-gate (command gating) and pix-ssh
 *               (host confirm when no password is missing).
 *   "sudo"    — SelectList → masked password input. Used by pix-sudo and pix-ssh
 *               (SSH login + remote sudo password entry).
 *
 * Both modes share: rounded modal frame (╭─╮╰─╯), solid bg, accent border,
 * title, body lines, optional countdown. Same visual style as pix-ask.
 *
 * Design goals:
 *   - Pure function — no side effects, no global state.
 *   - Fully unit-testable: inject a mock `ui` to drive inputs deterministically.
 *   - Single source of truth for the overlay look across pix-gate, pix-sudo, and pix-ssh.
 */

import { Input, type SelectItem, SelectList } from "@earendil-works/pi-tui";
import {
	frameModal,
	MIN_PERMISSION_MODAL_HEIGHT,
	type ModalPageKeybindings,
	ModalPager,
	modalOverlayOptions,
	modalWidth,
	selectListTheme,
	terminalModalHeight,
} from "./modal-frame.js";

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
	terminal?: { rows?: number };
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
		opts?: { overlay?: boolean; overlayOptions?: ReturnType<typeof modalOverlayOptions> },
	): Promise<T | undefined>;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_CHOICES: OverlayChoice[] = [
	{ value: "yes", label: "Allow", description: "Proceed" },
	{ value: "no", label: "Deny", description: "Block" },
];

function asPageKeybindings(value: unknown): ModalPageKeybindings | undefined {
	if (!value || typeof value !== "object") return undefined;
	return typeof (value as { matches?: unknown }).matches === "function"
		? (value as ModalPageKeybindings)
		: undefined;
}

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

interface OverlaySections {
	header: string[];
	body: string[];
	footer: string[];
}

/** Partition inspectable content from pinned approval controls. */
function buildSections(opts: {
	theme: OverlayTheme;
	accent: string;
	config: OverlayConfig;
	stage: "select" | "password";
	selectList: SelectList;
	maskedInput: MaskedInput;
	countdownLine: string | undefined;
	passwordStatus: string | undefined;
	width: number;
}): OverlaySections {
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
	const header = [theme.fg(accent, theme.bold(config.title))];
	const body = (config.body ?? []).map((line) => {
		if (line.startsWith("Intent:")) return theme.fg("text", line.slice(7).trimStart());
		if (line.startsWith("Command:")) return theme.fg("dim", line.slice(8).trimStart());
		if (line.startsWith("Warning:")) return theme.fg("warning", line);
		if (line.startsWith("(") && line.endsWith(")")) return theme.fg("dim", line);

		const separator = line.indexOf(":");
		if (separator < 1) return theme.fg("text", line);
		const label = line.slice(0, separator + 1);
		const value = line.slice(separator + 1).trimStart();
		const valueColors: Record<string, string> = {
			"Host:": "accent",
			"Direction:": "warning",
			"From:": "text",
			"To:": "accent",
			"Mode:": "muted",
			"Auth:": "success",
		};
		const valueColor = valueColors[label];
		return valueColor
			? `${theme.fg("dim", label)} ${theme.fg(valueColor, value)}`
			: theme.fg("text", line);
	});
	const footer = [theme.fg("dim", "─".repeat(inner))];

	if (countdownLine !== undefined) footer.push(countdownLine);

	// Select or password stage
	if (stage === "select") {
		footer.push(...selectList.render(inner));
		footer.push("");
		footer.push(theme.fg("dim", "↑↓ choose • ←→/PgUp/PgDn inspect • enter select • esc deny"));
	} else {
		const label = config.mode === "sudo" ? (config.passwordLabel ?? "Sudo password:") : "Password:";
		footer.push(theme.fg("muted", label));
		if (passwordStatus) footer.push(theme.fg("error", passwordStatus));
		footer.push(...maskedInput.render(inner));
		footer.push("");
		footer.push(theme.fg("dim", "←→/PgUp/PgDn inspect • enter confirm • esc cancel"));
	}

	return { header, body, footer };
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
			(tui, theme, kb, done) => {
				const pageKeybindings = asPageKeybindings(kb);
				type Stage = "select" | "password";
				let stage: Stage = "select";
				let countdownLine: string | undefined;
				let passwordStatus: string | undefined;
				let passwordAttempts = 0;
				let validatingPassword = false;
				const pager = new ModalPager();

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
					const urgencyColor = (s: number): string =>
						s <= 5 ? "error" : s <= 15 ? "warning" : "dim";
					const countdownText = (s: number): string => {
						const color = urgencyColor(s);
						const text = `auto-deny in ${s}s`;
						return s <= 5 ? theme.bold(theme.fg(color, text)) : theme.fg(color, text);
					};
					countdownLine = countdownText(remaining);
					timer = setInterval(() => {
						remaining -= 1;
						if (remaining <= 0) {
							finish({ action: "timeout" });
							return;
						}
						countdownLine = countdownText(remaining);
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
						const sections = buildSections({
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
						const result = frameModal({
							width: mw,
							maxHeight: terminalModalHeight(tui.terminal?.rows),
							minHeight: MIN_PERMISSION_MODAL_HEIGHT,
							...sections,
							bodyOffset: pager.bodyOffset,
							color: (s) => theme.fg(accent, s),
							bg: (s) => theme.bg("customMessageBg", s),
							fg: (s) => theme.fg("text", s),
							overflowLine: ({ page, totalPages }) =>
								theme.fg("dim", `←→/PgUp/PgDn inspect • ${page}/${totalPages}`),
						});
						pager.sync(result);
						return result.lines;
					},
					invalidate: () => {},
					handleInput: (data) => {
						cancelTimer(); // user is present — stop the auto-deny countdown
						if (validatingPassword) return;
						if (pager.handleInput(data, pageKeybindings, true)) {
							tui.requestRender();
							return;
						}
						if (stage === "select") selectList.handleInput(data);
						else maskedInput.handleInput(data);
						tui.requestRender();
					},
				};
			},
			{ overlay: true, overlayOptions: modalOverlayOptions() },
		).then((result) => {
			resolve(result ?? { action: "denied" });
		});
	});
}
