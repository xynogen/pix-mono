import { describe, expect, it } from "bun:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Exec } from "./update.ts";
import {
	currentVersion,
	formatUpdateSummary,
	isTransient,
	PI_SELF_UPDATE,
	PIX_INSTALL_COMMAND,
	PIX_INSTALL_URL,
	PIX_UNINSTALL_URL,
	runWithRetry,
	SPINNER,
	withSpinner,
} from "./update.ts";

// ─── helpers ─────────────────────────────────────────────────────────────────

type ExecResult = { stdout: string; stderr: string; code: number };

/** Build a minimal ExtensionAPI stub with a controllable exec implementation. */
function makePi(execImpl: (...args: unknown[]) => Promise<ExecResult>) {
	return { exec: execImpl } as unknown as ExtensionAPI;
}

// ─── isTransient ─────────────────────────────────────────────────────────────

describe("isTransient", () => {
	it("matches network errors", () => {
		expect(isTransient("ETIMEDOUT")).toBe(true);
		expect(isTransient("ECONNRESET")).toBe(true);
		expect(isTransient("ECONNREFUSED")).toBe(true);
		expect(isTransient("socket hang up")).toBe(true);
		expect(isTransient("network error occurred")).toBe(true);
	});

	it("matches HTTP status codes", () => {
		expect(isTransient("Error 429: Too many requests")).toBe(true);
		expect(isTransient("502 Bad Gateway")).toBe(true);
		expect(isTransient("503 Service Unavailable")).toBe(true);
		expect(isTransient("504 Gateway Timeout")).toBe(true);
	});

	it("matches timeout/temporary", () => {
		expect(isTransient("Request timeout after 30s")).toBe(true);
		expect(isTransient("temporary failure")).toBe(true);
		expect(isTransient("EAI_AGAIN")).toBe(true);
	});

	it("returns false for permanent errors", () => {
		expect(isTransient("permission denied")).toBe(false);
		expect(isTransient("command not found")).toBe(false);
		expect(isTransient("syntax error")).toBe(false);
		expect(isTransient("")).toBe(false);
	});

	it("is case-insensitive", () => {
		expect(isTransient("NETWORK FAILURE")).toBe(true);
		expect(isTransient("Timeout after 30s")).toBe(true);
	});
});

// ─── PI_SELF_UPDATE ──────────────────────────────────────────────────────────

describe("PI_SELF_UPDATE", () => {
	it("delegates to Pi's own self-updater", () => {
		expect(PI_SELF_UPDATE).toEqual({
			command: "pi",
			args: ["update", "--self"],
			label: "pi update --self",
		});
	});
});

// ─── formatUpdateSummary ──────────────────────────────────────────────────────

describe("formatUpdateSummary", () => {
	it("shows upgrade arrow when version changed", () => {
		const msg = formatUpdateSummary("0.75.0", "0.76.0", 1);
		expect(msg).toContain("0.75.0 → 0.76.0");
	});

	it("shows up-to-date when version unchanged", () => {
		const msg = formatUpdateSummary("0.76.0", "0.76.0", 1);
		expect(msg).toContain("up to date");
		expect(msg).toContain("0.76.0");
	});

	it("appends retry count when attempts > 1", () => {
		const msg = formatUpdateSummary("0.75.0", "0.76.0", 3);
		expect(msg).toContain("Retried 2 transient failure");
	});

	it("no retry mention when attempts = 1", () => {
		const msg = formatUpdateSummary("0.75.0", "0.76.0", 1);
		expect(msg).not.toContain("Retried");
	});

	it("treats unknown→unknown as up-to-date (no arrow)", () => {
		const msg = formatUpdateSummary("unknown", "unknown", 1);
		expect(msg).not.toContain("→");
		expect(msg).toContain("up to date");
	});

	it("treats known→unknown as up-to-date (no arrow)", () => {
		// After an update the new version read fails; should not show a bad arrow.
		const msg = formatUpdateSummary("0.75.0", "unknown", 1);
		expect(msg).not.toContain("→");
	});
});

// ─── constants ───────────────────────────────────────────────────────────────

describe("withSpinner", () => {
	type StatusCall = [string, string | undefined];
	it("sets a spinner line then clears it, even when work throws", async () => {
		const calls: Array<StatusCall> = [];
		const ui = {
			setStatus: (k: string, t: string | undefined) => calls.push([k, t]),
		};
		await expect(
			withSpinner(ui, "k", "Working", async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		// first call sets a spinner frame, last call clears the line.
		const c0 = calls[0] as StatusCall;
		expect(c0[0]).toBe("k");
		expect(c0[1]).toContain("Working");
		expect(c0[1]?.[0]).toBe(SPINNER[0] ?? "");
		expect(calls.at(-1)).toEqual(["k", undefined]);
	});
});

describe("constants", () => {
	it("PIX_INSTALL_URL points to pix-mono main branch", () => {
		expect(PIX_INSTALL_URL).toContain("xynogen/pix-mono");
		expect(PIX_INSTALL_URL).toContain("install.sh");
	});

	it("PIX_INSTALL_COMMAND uninstalls then reinstalls via sh", () => {
		expect(PIX_INSTALL_COMMAND).toContain(PIX_UNINSTALL_URL);
		expect(PIX_INSTALL_COMMAND).toContain(PIX_INSTALL_URL);
		// uninstall must run before install
		expect(PIX_INSTALL_COMMAND.indexOf(PIX_UNINSTALL_URL)).toBeLessThan(
			PIX_INSTALL_COMMAND.indexOf(PIX_INSTALL_URL),
		);
		expect(PIX_INSTALL_COMMAND).toContain("&&");
	});
});

// ─── currentVersion ───────────────────────────────────────────────────────────

describe("currentVersion", () => {
	it("returns trimmed stdout when present", async () => {
		const pi = makePi(async () => ({
			stdout: "0.77.0\n",
			stderr: "",
			code: 0,
		}));
		expect(await currentVersion(pi)).toBe("0.77.0");
	});

	it("falls back to stderr when stdout is empty", async () => {
		const pi = makePi(async () => ({
			stdout: "",
			stderr: "0.77.0",
			code: 0,
		}));
		expect(await currentVersion(pi)).toBe("0.77.0");
	});

	it("returns 'unknown' when both streams are empty", async () => {
		const pi = makePi(async () => ({ stdout: "", stderr: "", code: 0 }));
		expect(await currentVersion(pi)).toBe("unknown");
	});
});

// ─── runWithRetry ─────────────────────────────────────────────────────────────

describe("runWithRetry", () => {
	// Skip the real backoff wait so retry tests stay fast.
	const noSleep = async () => {};
	const spec = {
		command: "bun",
		args: ["add", "-g", "pkg@latest"],
		label: "bun add -g pkg@latest",
	};

	it("returns ok=true on first success", async () => {
		const pi = makePi(async () => ({
			stdout: "Successfully installed",
			stderr: "",
			code: 0,
		}));
		const result = await runWithRetry(pi, spec);
		expect(result.ok).toBe(true);
		expect(result.attempts).toBe(1);
		expect(result.output).toContain("Successfully installed");
	});

	it("retries on transient errors and succeeds on second attempt", async () => {
		let calls = 0;
		const pi = makePi(async () => {
			calls++;
			if (calls < 2) return { stdout: "", stderr: "ETIMEDOUT", code: 1 };
			return { stdout: "ok", stderr: "", code: 0 };
		});
		const result = await runWithRetry(pi, spec, noSleep);
		expect(result.ok).toBe(true);
		expect(result.attempts).toBe(2);
	});

	it("stops immediately on permanent (non-transient) error", async () => {
		let calls = 0;
		const pi = makePi(async () => {
			calls++;
			return { stdout: "", stderr: "permission denied", code: 1 };
		});
		const result = await runWithRetry(pi, spec);
		expect(result.ok).toBe(false);
		expect(result.attempts).toBe(1);
		expect(calls).toBe(1);
	});

	it("gives up after 3 transient failures", async () => {
		const pi = makePi(async () => ({
			stdout: "",
			stderr: "ETIMEDOUT",
			code: 1,
		}));
		const result = await runWithRetry(pi, spec, noSleep);
		expect(result.ok).toBe(false);
		expect(result.attempts).toBe(3);
	});

	it("concatenates stdout + stderr into output", async () => {
		const pi = makePi(async () => ({
			stdout: "out line",
			stderr: "err line",
			code: 0,
		}));
		const result = await runWithRetry(pi, spec);
		expect(result.output).toContain("out line");
		expect(result.output).toContain("err line");
	});

	it("omits empty streams from output", async () => {
		const pi = makePi(async () => ({
			stdout: "only stdout",
			stderr: "",
			code: 0,
		}));
		const result = await runWithRetry(pi, spec);
		expect(result.output).toBe("only stdout");
	});

	it("treats code=undefined as success (0)", async () => {
		const pi = makePi(async () => ({
			stdout: "done",
			stderr: "",
			code: undefined as unknown as number,
		}));
		const result = await runWithRetry(pi, spec);
		expect(result.ok).toBe(true);
	});

	it("fails a timed-out run without retrying it", async () => {
		let calls = 0;
		const exec: Exec = async () => {
			calls++;
			return { stdout: "partial", stderr: "", code: null, timedOut: true };
		};
		const result = await runWithRetry(exec, spec, noSleep);
		expect(result).toMatchObject({ ok: false, attempts: 1 });
		expect(result.output).toMatch(/^partial\nTimed out after \d+s\.$/);
		expect(calls).toBe(1);
	});

	it("fails a run killed by a signal (code=null)", async () => {
		const exec: Exec = async () => ({ stdout: "", stderr: "killed", code: null });
		const result = await runWithRetry(exec, spec, noSleep);
		expect(result.ok).toBe(false);
	});
});
