import { describe, expect, test } from "bun:test";
import {
	detectAuthFailure,
	filterSudoPrompt,
	MAX_OUTPUT_BYTES,
	MAX_OUTPUT_LINES,
	truncate,
} from "./lib.ts";

// ── truncate ─────────────────────────────────────────────────────────────────

describe("truncate", () => {
	test("short text passes through unchanged", () => {
		const result = truncate("hello\nworld");
		expect(result).toEqual({ text: "hello\nworld", truncated: false });
	});

	test("exact-limit line count is not truncated", () => {
		const text = Array.from({ length: MAX_OUTPUT_LINES }, (_, i) => `line ${i}`).join("\n");
		const result = truncate(text);
		expect(result.truncated).toBe(false);
	});

	test("one-over line limit truncates", () => {
		const text = Array.from({ length: MAX_OUTPUT_LINES + 1 }, (_, i) => `line ${i}`).join("\n");
		const result = truncate(text);
		expect(result.truncated).toBe(true);
		expect(result.text.split("\n")).toHaveLength(MAX_OUTPUT_LINES);
	});

	test("byte limit truncates independently of line count", () => {
		// 4 lines, each 20 KB — well over 50 KB total but only 4 lines
		const bigLine = "x".repeat(20 * 1024);
		const text = [bigLine, bigLine, bigLine, bigLine].join("\n");
		const result = truncate(text);
		expect(result.truncated).toBe(true);
		expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
	});

	test("custom maxLines override", () => {
		const text = "a\nb\nc\nd\ne";
		const result = truncate(text, 3, MAX_OUTPUT_BYTES);
		expect(result.truncated).toBe(true);
		expect(result.text).toBe("a\nb\nc");
	});

	test("custom maxBytes override", () => {
		const text = "abcde";
		const result = truncate(text, MAX_OUTPUT_LINES, 3);
		expect(result.truncated).toBe(true);
		expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(3);
	});

	test("empty string passes through", () => {
		expect(truncate("")).toEqual({ text: "", truncated: false });
	});

	test("single long line truncated by bytes keeps valid utf8", () => {
		// Mix of ASCII and multi-byte chars
		const text = "café ".repeat(5000);
		const result = truncate(text, MAX_OUTPUT_LINES, 100);
		expect(result.truncated).toBe(true);
		// Should not throw — valid UTF-8 string
		expect(() => Buffer.from(result.text, "utf8")).not.toThrow();
	});
});

// ── filterSudoPrompt ─────────────────────────────────────────────────────────

describe("filterSudoPrompt", () => {
	test("strips standard sudo password prompt line", () => {
		const raw = "[sudo] password for alice:\ncommand output here";
		expect(filterSudoPrompt(raw)).not.toContain("[sudo] password");
		expect(filterSudoPrompt(raw)).toContain("command output here");
	});

	test("strips prompt with different username", () => {
		const raw = "[sudo] password for root:\nsome error";
		expect(filterSudoPrompt(raw)).not.toContain("[sudo]");
	});

	test("case-insensitive match", () => {
		const raw = "[SUDO] Password for bob:\nok";
		expect(filterSudoPrompt(raw)).not.toContain("[SUDO]");
	});

	test("preserves non-prompt stderr lines", () => {
		const raw = "real error: file not found\n[sudo] password for x:\nanother line";
		const out = filterSudoPrompt(raw);
		expect(out).toContain("real error: file not found");
		expect(out).toContain("another line");
		expect(out).not.toContain("[sudo] password");
	});

	test("empty string returns empty string", () => {
		expect(filterSudoPrompt("")).toBe("");
	});

	test("no prompt lines unchanged", () => {
		const raw = "stdout line\nstderr line";
		expect(filterSudoPrompt(raw)).toBe(raw);
	});
});

// ── detectAuthFailure ────────────────────────────────────────────────────────

describe("detectAuthFailure", () => {
	test("code 0 is never an auth failure", () => {
		expect(detectAuthFailure(0, "incorrect password")).toBe(false);
		expect(detectAuthFailure(0, "authentication failure")).toBe(false);
		expect(detectAuthFailure(0, "sorry, try again")).toBe(false);
	});

	test("detects 'incorrect password' in stderr", () => {
		expect(detectAuthFailure(1, "sudo: incorrect password")).toBe(true);
	});

	test("detects 'authentication failure' in stderr", () => {
		expect(detectAuthFailure(1, "pam: authentication failure")).toBe(true);
	});

	test("detects 'sorry,' in stderr (sudo try-again message)", () => {
		expect(detectAuthFailure(1, "Sorry, try again.")).toBe(true);
	});

	test("detects '3 incorrect password attempts'", () => {
		expect(detectAuthFailure(1, "sudo: 3 incorrect password attempts")).toBe(true);
	});

	test("non-zero exit with unrelated stderr is not auth failure", () => {
		expect(detectAuthFailure(1, "No such file or directory")).toBe(false);
		expect(detectAuthFailure(127, "command not found")).toBe(false);
	});

	test("case-insensitive for 'incorrect password'", () => {
		expect(detectAuthFailure(1, "Incorrect Password")).toBe(true);
	});

	test("case-insensitive for 'authentication failure'", () => {
		expect(detectAuthFailure(1, "Authentication Failure")).toBe(true);
	});

	test("empty stderr with non-zero code is not auth failure", () => {
		expect(detectAuthFailure(1, "")).toBe(false);
	});
});

// ── execute integration (mock host) ──────────────────────────────────────────
//
// Tests the full execute() path with a fake ExtensionAPI + fake UI.
// No real sudo is spawned — runWithSudo is never reached unless the overlay
// resolves with choice="allow" + a non-blank password.
//
// UI shape after the shared pix-pretty overlay refactor:
//   ctx.ui.custom()  — one overlay covering both confirm + password stages
//                      resolves { action: "approved"|"denied"|"timeout", password? }
//   ctx.ui.notify()  — fire-and-forget (swallowed in mock)

import { mock } from "bun:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import type { SudoResult } from "./lib.ts";

// Swappable runWithSudo stub — index.ts imports the mocked module.
// Default throws so any unstubbed sudo call is an obvious test bug.
let sudoMock: (cmd: string, pw: string) => Promise<SudoResult> = async () => {
	throw new Error("runWithSudo not stubbed for this test");
};
let validationMock: (pw: string) => Promise<SudoResult> = async () => ({
	stdout: "",
	stderr: "",
	code: 0,
});
// Default: no cached ticket — the password stage runs (matches most tests).
let ticketMock = false;
mock.module("./lib.ts", () => {
	const actual = require("./lib.ts");
	return {
		...actual,
		runWithSudo: (c: string, p: string) => sudoMock(c, p),
		validateSudoPassword: (p: string) => validationMock(p),
		hasValidTicket: async () => ticketMock,
	};
});

import { COLLAPSED_TOOL_GLYPH, padIcon, termW } from "@xynogen/pix-pretty/utils";
import registerSudo from "./index.ts";

// Minimal theme stub: returns text unchanged so assertions match plain strings.
const stubTheme = {
	fg: (_color: string, t: string) => t,
	bold: (t: string) => t,
	bg: (_color: string, t: string) => t,
};

const stubTui = { requestRender: () => {} };

interface OverlayResult {
	action: "approved" | "denied" | "timeout";
	password?: string;
}

type CustomCb<T> = (
	tui: typeof stubTui,
	theme: typeof stubTheme,
	kb: undefined,
	done: (v: T) => void,
) => {
	render: (w: number) => string[];
	invalidate: () => void;
	handleInput: (d: string) => void;
};

type SudoToolResult = {
	content: Array<{ type: string; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
};

type UpdateFn = (result: SudoToolResult) => void;

type ExecuteFn = (
	id: string,
	params: { command: string; reason?: string },
	signal: AbortSignal | undefined,
	onUpdate: UpdateFn | undefined,
	ctx: {
		hasUI: boolean;
		ui: {
			custom: <T>(cb: CustomCb<T>, opts?: { overlay?: boolean }) => Promise<T | undefined>;
			notify: (msg: string, level: string) => void;
			theme: typeof stubTheme;
		};
	},
) => Promise<SudoToolResult>;

type RenderComponent = {
	render: (width: number) => string[];
};

type SudoToolDefinition = {
	name: string;
	execute: ExecuteFn;
	renderCall?: (...args: unknown[]) => RenderComponent;
	renderResult?: (...args: unknown[]) => RenderComponent;
};

function makeHost(onState?: (state: string) => void) {
	let captured: SudoToolDefinition | null = null;
	const events = createEventBus();
	if (onState) {
		events.on("pix:agent-state", (event) => onState((event as { state: string }).state));
	}
	const pi = {
		events,
		registerTool(def: SudoToolDefinition) {
			captured = def;
		},
	} as never;
	registerSudo(pi);
	return {
		get execute(): ExecuteFn {
			if (!captured) throw new Error("tool not registered");
			return captured.execute;
		},
		get renderCall() {
			if (!captured?.renderCall) throw new Error("renderCall not registered");
			return captured.renderCall;
		},
		get renderResult() {
			if (!captured?.renderResult) throw new Error("renderResult not registered");
			return captured.renderResult;
		},
	};
}

function rendered(component: RenderComponent): string {
	// Rows are padded to termW() by fillToolBackground; render at the same width
	// so the baked line fits exactly (a fixed width wider/narrower than termW()
	// would wrap or clip, flaking the one-line assertions under a real tty).
	return component.render(termW()).join("\n");
}

function renderResult(
	host: ReturnType<typeof makeHost>,
	result: SudoToolResult,
	expanded: boolean,
	state: Record<string, unknown> = { collapsed: true },
): string {
	return rendered(
		host.renderResult(result, { expanded, isPartial: false }, stubTheme, {
			expanded,
			isError: result.isError === true,
			invalidate: () => {},
			state,
		}),
	);
}

/**
 * overlayResult — what ctx.ui.custom() resolves to.
 *   action="approved" + non-blank password     => runs sudo
 *   action="denied"                            => cancelled by user
 *   action="timeout"                           => auto-denied
 *   action="approved" + blank/missing password => cancelled
 *
 * onCustom — called with rendered lines after the component renders once.
 */
function makeCtx(
	opts: {
		hasUI?: boolean;
		overlayResult?: OverlayResult;
		overlayResults?: OverlayResult[];
		onCustom?: (lines: string[]) => void;
	} = {},
) {
	const overlayResults = opts.overlayResults ?? [opts.overlayResult ?? { action: "denied" }];
	let overlayIndex = 0;
	return {
		hasUI: opts.hasUI ?? true,
		ui: {
			custom: async <T>(cb: CustomCb<T>): Promise<T | undefined> => {
				let completed: T | undefined;
				const comp = cb(stubTui, stubTheme, undefined, (value: T) => {
					completed = value;
				});
				const lines = comp.render(80);
				opts.onCustom?.(lines);

				// Multi-result tests drive the real two-stage overlay so validation and
				// retries occur while this single custom component remains mounted.
				if (
					opts.overlayResults ||
					(overlayResults[0]?.action === "approved" && Boolean(overlayResults[0].password?.trim()))
				) {
					comp.handleInput("\r");
					for (const result of overlayResults) {
						if (result.action !== "approved") return result as T;
						comp.handleInput(result.password ?? "");
						comp.handleInput("\r");
						await new Promise((resolve) => setTimeout(resolve, 0));
						if (completed) return completed;
					}
					return completed;
				}

				const result = overlayResults[Math.min(overlayIndex, overlayResults.length - 1)];
				overlayIndex += 1;
				return result as T;
			},
			notify: (_msg: string, _level: string) => {},
			theme: stubTheme,
		},
	};
}

function text(result: { content: Array<{ type: string; text: string }> }) {
	return result.content.map((c) => c.text).join("\n");
}

describe("sudo_run tool execute()", () => {
	test("reports blocked while waiting for root approval", async () => {
		const states: string[] = [];
		const host = makeHost((state) => states.push(state));
		await host.execute(
			"id",
			{ command: "whoami" },
			undefined,
			undefined,
			makeCtx({ overlayResult: { action: "denied" } }),
		);
		expect(states).toContain("blocked");
		expect(states.at(-1)).toBe("idle");
	});

	test("AFK mode denies immediately without opening UI", async () => {
		(globalThis as { __pixAfk?: boolean }).__pixAfk = true;
		const host = makeHost();
		let opened = false;
		const result = await host.execute(
			"id",
			{ command: "whoami" },
			undefined,
			undefined,
			makeCtx({
				onCustom: () => {
					opened = true;
				},
			}),
		);
		delete (globalThis as { __pixAfk?: boolean }).__pixAfk;
		expect(opened).toBe(false);
		expect(text(result)).toContain("denied immediately");
		expect(result.details.outcome).toBe("denied");
	});

	test("no UI returns error immediately", async () => {
		const host = makeHost();
		const result = await host.execute(
			"id",
			{ command: "whoami" },
			undefined,
			undefined,
			makeCtx({ hasUI: false }),
		);
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("no UI available");
	});

	test("YOLO + cached ticket auto-approves without opening the overlay", async () => {
		(globalThis as { __pixYolo?: boolean }).__pixYolo = true;
		ticketMock = true;
		sudoMock = async () => ({ stdout: "root", stderr: "", code: 0 });
		const host = makeHost();
		let opened = false;
		const result = await host.execute(
			"id",
			{ command: "whoami" },
			undefined,
			undefined,
			makeCtx({
				onCustom: () => {
					opened = true;
				},
			}),
		);
		delete (globalThis as { __pixYolo?: boolean }).__pixYolo;
		ticketMock = false;
		sudoMock = async () => {
			throw new Error("runWithSudo not stubbed for this test");
		};
		expect(opened).toBe(false);
		expect(result.details.outcome).toBe("success");
		expect(text(result)).toContain("root");
	});

	test("YOLO WITHOUT a cached ticket still prompts for the password", async () => {
		(globalThis as { __pixYolo?: boolean }).__pixYolo = true;
		ticketMock = false;
		const host = makeHost();
		let opened = false;
		const result = await host.execute(
			"id",
			{ command: "whoami" },
			undefined,
			undefined,
			makeCtx({
				overlayResult: { action: "denied" },
				onCustom: () => {
					opened = true;
				},
			}),
		);
		delete (globalThis as { __pixYolo?: boolean }).__pixYolo;
		expect(opened).toBe(true); // no ticket => cannot auto-type password => overlay shown
		expect(text(result)).toContain("Denied by user");
	});

	test("action=denied => cancelled", async () => {
		const host = makeHost();
		const result = await host.execute(
			"id",
			{ command: "whoami" },
			undefined,
			undefined,
			makeCtx({ overlayResult: { action: "denied" } }),
		);
		expect(text(result)).toContain("Denied by user");
		expect(result.isError).toBeUndefined();
	});

	test("action=timeout => cancelled", async () => {
		const host = makeHost();
		const result = await host.execute(
			"id",
			{ command: "whoami" },
			undefined,
			undefined,
			makeCtx({ overlayResult: { action: "timeout" } }),
		);
		expect(text(result)).toContain("Timed out");
		expect(result.isError).toBeUndefined();
	});

	test("action=approved + blank password => cancelled", async () => {
		const host = makeHost();
		const result = await host.execute(
			"id",
			{ command: "whoami" },
			undefined,
			undefined,
			makeCtx({ overlayResult: { action: "approved", password: "" } }),
		);
		expect(text(result)).toContain("no password entered");
		expect(result.isError).toBeUndefined();
	});

	test("action=approved + whitespace password => cancelled", async () => {
		const host = makeHost();
		const result = await host.execute(
			"id",
			{ command: "whoami" },
			undefined,
			undefined,
			makeCtx({ overlayResult: { action: "approved", password: "   " } }),
		);
		expect(text(result)).toContain("no password entered");
	});

	test("action=approved + undefined password => cancelled", async () => {
		const host = makeHost();
		const result = await host.execute(
			"id",
			{ command: "whoami" },
			undefined,
			undefined,
			makeCtx({ overlayResult: { action: "approved", password: undefined } }),
		);
		expect(text(result)).toContain("no password entered");
		expect(result.isError).toBeUndefined();
	});

	test("action=approved + password => runs sudo (happy path)", async () => {
		sudoMock = async () => ({ stdout: "root", stderr: "", code: 0 });
		const host = makeHost();
		const result = await host.execute(
			"id",
			{ command: "whoami" },
			undefined,
			undefined,
			makeCtx({ overlayResult: { action: "approved", password: "hunter2" } }),
		);
		expect(text(result)).toContain("Exit code: 0");
		expect(text(result)).toContain("root");
		expect(result.isError).toBe(false);
	});

	test("wrong password is prompted three times before auth failure", async () => {
		let attempts = 0;
		validationMock = async () => {
			attempts += 1;
			return { stdout: "", stderr: "sudo: incorrect password", code: 1 };
		};
		const host = makeHost();
		let overlayCount = 0;
		const result = await host.execute(
			"id",
			{ command: "whoami" },
			undefined,
			undefined,
			makeCtx({
				overlayResults: [
					{ action: "approved", password: "wrong-1" },
					{ action: "approved", password: "wrong-2" },
					{ action: "approved", password: "wrong-3" },
				],
				onCustom: () => {
					overlayCount += 1;
				},
			}),
		);
		expect(attempts).toBe(3);
		expect(overlayCount).toBe(1);
		expect(text(result)).toContain("authentication failed after 3 attempts");
		expect(result.isError).toBe(true);
	});

	test("correct password on a retry runs successfully", async () => {
		const seenPasswords: string[] = [];
		validationMock = async (password) => {
			seenPasswords.push(password);
			return password === "correct"
				? { stdout: "", stderr: "", code: 0 }
				: { stdout: "", stderr: "Sorry, try again.", code: 1 };
		};
		sudoMock = async () => ({ stdout: "root", stderr: "", code: 0 });
		const host = makeHost();
		const result = await host.execute(
			"id",
			{ command: "whoami" },
			undefined,
			undefined,
			makeCtx({
				overlayResults: [
					{ action: "approved", password: "wrong" },
					{ action: "approved", password: "correct" },
				],
			}),
		);
		expect(seenPasswords).toEqual(["wrong", "correct"]);
		expect(text(result)).toContain("Exit code: 0");
		expect(text(result)).toContain("root");
		expect(result.isError).toBe(false);
	});

	test("password validation is separate from command execution", async () => {
		const events: string[] = [];
		validationMock = async (password) => {
			events.push(`validate:${password}`);
			return { stdout: "", stderr: "", code: 0 };
		};
		sudoMock = async (command, password) => {
			events.push(`run:${command}:${password}`);
			return { stdout: "done", stderr: "", code: 0 };
		};
		const host = makeHost();
		const result = await host.execute(
			"id",
			{ command: "slow-command" },
			undefined,
			undefined,
			makeCtx({ overlayResult: { action: "approved", password: "secret" } }),
		);
		expect(events).toEqual(["validate:secret", "run:slow-command:"]);
		expect(text(result)).toContain("done");
	});

	test("cached ticket => confirm only, runs sudo with empty password", async () => {
		ticketMock = true;
		let seenPassword: string | undefined;
		sudoMock = async (_c, pw) => {
			seenPassword = pw;
			return { stdout: "root", stderr: "", code: 0 };
		};
		try {
			const host = makeHost();
			// No password supplied — confirm-only overlay returns just the action.
			const result = await host.execute(
				"id",
				{ command: "whoami" },
				undefined,
				undefined,
				makeCtx({ overlayResult: { action: "approved" } }),
			);
			expect(text(result)).toContain("Exit code: 0");
			expect(result.isError).toBe(false);
			expect(seenPassword).toBe("");
		} finally {
			ticketMock = false;
		}
	});

	test("cached ticket => deny still blocks", async () => {
		ticketMock = true;
		sudoMock = async () => {
			throw new Error("must not run sudo when denied");
		};
		try {
			const host = makeHost();
			const result = await host.execute(
				"id",
				{ command: "whoami" },
				undefined,
				undefined,
				makeCtx({ overlayResult: { action: "denied" } }),
			);
			expect(text(result)).toContain("Denied by user");
		} finally {
			ticketMock = false;
		}
	});

	test("returns structured outcomes and compact terminal rows", async () => {
		validationMock = async () => ({ stdout: "", stderr: "", code: 0 });

		const successHost = makeHost();
		sudoMock = async () => ({
			stdout: Array.from({ length: 18 }, (_, i) => `installed ${i + 1}`).join("\n"),
			stderr: "",
			code: 0,
		});
		const success = await successHost.execute(
			"id",
			{ command: "apt install ripgrep", reason: "Install ripgrep" },
			undefined,
			undefined,
			makeCtx({ overlayResult: { action: "approved", password: "secret-value" } }),
		);
		expect(success.details).toMatchObject({
			_type: "sudoResult",
			command: "apt install ripgrep",
			reason: "Install ripgrep",
			outcome: "success",
			exitCode: 0,
			lineCount: 18,
			truncated: false,
		});
		// Markers are width-normalized (padIcon) so 1-cell and 2-cell glyphs align.
		expect(renderResult(successHost, success, false)).toContain(
			`${padIcon(COLLAPSED_TOOL_GLYPH.success)} sudo apt install ripgrep · exit 0 · 18 lines`,
		);

		const deniedHost = makeHost();
		const denied = await deniedHost.execute(
			"id",
			{ command: "systemctl restart foo" },
			undefined,
			undefined,
			makeCtx({ overlayResult: { action: "denied" } }),
		);
		expect(denied.details).toMatchObject({ outcome: "denied", cancellationKind: "denied" });
		expect(renderResult(deniedHost, denied, false)).toContain(
			`${padIcon(COLLAPSED_TOOL_GLYPH.warning)} sudo systemctl restart foo · denied`,
		);

		const timeoutHost = makeHost();
		const timedOut = await timeoutHost.execute(
			"id",
			{ command: "apt update" },
			undefined,
			undefined,
			makeCtx({ overlayResult: { action: "timeout" } }),
		);
		expect(timedOut.details).toMatchObject({ outcome: "timed-out", cancellationKind: "timeout" });
		expect(renderResult(timeoutHost, timedOut, false)).toContain(
			`${padIcon(COLLAPSED_TOOL_GLYPH.warning)} sudo apt update · timed out`,
		);

		const failedHost = makeHost();
		sudoMock = async () => ({
			stdout: "",
			stderr: Array.from({ length: 12 }, (_, i) => `error ${i + 1}`).join("\n"),
			code: 1,
		});
		const failed = await failedHost.execute(
			"id",
			{ command: "apt update" },
			undefined,
			undefined,
			makeCtx({ overlayResult: { action: "approved", password: "secret-value" } }),
		);
		expect(failed.details).toMatchObject({
			outcome: "error",
			exitCode: 1,
			lineCount: 12,
			errorKind: "exit-code",
		});
		expect(renderResult(failedHost, failed, false)).toContain(
			`${padIcon(COLLAPSED_TOOL_GLYPH.error)} sudo apt update · exit 1 · 12 lines`,
		);
	});

	test("sanitizes multiline commands in compact rows", async () => {
		validationMock = async () => ({ stdout: "", stderr: "", code: 0 });
		sudoMock = async () => ({ stdout: "done", stderr: "", code: 0 });
		const host = makeHost();
		const result = await host.execute(
			"id",
			{ command: "apt update\nprintf injected" },
			undefined,
			undefined,
			makeCtx({ overlayResult: { action: "approved", password: "secret-value" } }),
		);
		const compact = renderResult(host, result, false);
		expect(compact).toContain("sudo apt update printf injected");
		expect(compact.split("\n")).toHaveLength(1);
	});

	test("expanded results restore exact output and call rows", async () => {
		validationMock = async () => ({ stdout: "", stderr: "", code: 0 });
		sudoMock = async () => ({ stdout: "original stdout", stderr: "original stderr", code: 0 });
		const host = makeHost();
		const result = await host.execute(
			"id",
			{ command: "printf output", reason: "Verify output rendering" },
			undefined,
			undefined,
			makeCtx({ overlayResult: { action: "approved", password: "do-not-render-me" } }),
		);

		const state = { collapsed: true };
		const collapsedCall = rendered(
			host.renderCall({ command: "printf output", reason: "Verify output rendering" }, stubTheme, {
				expanded: false,
				state,
				invalidate: () => {},
			}),
		);
		const expandedCall = rendered(
			host.renderCall({ command: "printf output", reason: "Verify output rendering" }, stubTheme, {
				expanded: true,
				state,
				invalidate: () => {},
			}),
		);

		expect(collapsedCall).toBe("");
		expect(expandedCall).toContain("sudo printf output");
		const expandedResult = renderResult(host, result, true, state);
		expect(expandedResult).toContain("original stdout");
		expect(expandedResult).toContain("original stderr");
		expect(JSON.stringify(result.details)).not.toContain("do-not-render-me");
		expect(expandedCall).not.toContain("do-not-render-me");
		expect(expandedResult).not.toContain("do-not-render-me");
	});

	test("publishes only awaiting-approval and running updates before completion", async () => {
		validationMock = async () => ({ stdout: "", stderr: "", code: 0 });
		sudoMock = async () => ({ stdout: "done", stderr: "", code: 0 });
		const updates: SudoToolResult[] = [];
		const host = makeHost();
		await host.execute(
			"id",
			{ command: "apt update", reason: "Refresh package indexes" },
			undefined,
			(update) => updates.push(update),
			makeCtx({ overlayResult: { action: "approved", password: "secret-value" } }),
		);

		expect(updates.map((update) => update.details.outcome)).toEqual([
			"awaiting-approval",
			"running",
		]);
		expect(JSON.stringify(updates)).not.toContain("secret-value");
	});

	test("overlay renders the command", async () => {
		const host = makeHost();
		const rendered: string[] = [];
		await host.execute(
			"id",
			{ command: "rm -rf /tmp/test" },
			undefined,
			undefined,
			makeCtx({
				overlayResult: { action: "denied" },
				onCustom: (lines) => rendered.push(...lines),
			}),
		);
		expect(rendered.join("\n")).toContain("rm -rf /tmp/test");
	});

	test("overlay renders the reason when provided", async () => {
		const host = makeHost();
		const rendered: string[] = [];
		await host.execute(
			"id",
			{
				command: "chmod 755 /usr/local/bin/foo",
				reason: "Make binary executable",
			},
			undefined,
			undefined,
			makeCtx({
				overlayResult: { action: "denied" },
				onCustom: (lines) => rendered.push(...lines),
			}),
		);
		expect(rendered.join("\n")).toContain("Make binary executable");
	});

	test("overlay shows fallback when no reason provided", async () => {
		const host = makeHost();
		const rendered: string[] = [];
		await host.execute(
			"id",
			{ command: "id" },
			undefined,
			undefined,
			makeCtx({
				overlayResult: { action: "denied" },
				onCustom: (lines) => rendered.push(...lines),
			}),
		);
		expect(rendered.join("\n")).toContain("No reason provided");
	});
});
