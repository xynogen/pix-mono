/**
 * Pure / side-effect-free helpers extracted from index.ts so they can be
 * unit-tested without spawning real sudo or loading the Pi extension host.
 */

import { runTool } from "@xynogen/pix-runtime/exec";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@xynogen/pix-runtime/host";

export { truncateOutput as truncate } from "@xynogen/pix-runtime/utf8";

// Pi's own tool-output limits (50KB / 2000 lines), so every tool caps the same way.
export const MAX_OUTPUT_BYTES = DEFAULT_MAX_BYTES;
export const MAX_OUTPUT_LINES = DEFAULT_MAX_LINES;

// ── sudo stderr filter ───────────────────────────────────────────────────────

/** Strip the "[sudo] password for …:" prompt lines that sudo writes to stderr. */
export function filterSudoPrompt(raw: string): string {
	return raw
		.split("\n")
		.filter((l) => !/^\[sudo\] password/i.test(l))
		.join("\n");
}

// ── Auth-failure detection ───────────────────────────────────────────────────

export function detectAuthFailure(code: number, stderr: string): boolean {
	if (code === 0) return false;
	const lower = stderr.toLowerCase();
	return (
		lower.includes("incorrect password") ||
		lower.includes("authentication failure") ||
		lower.includes("sorry,") ||
		stderr.includes("3 incorrect password attempts")
	);
}

// ── sudo runner ──────────────────────────────────────────────────────────────

export interface SudoResult {
	stdout: string;
	stderr: string;
	code: number;
}

/**
 * Validate a sudo password with a minimal command and refresh the PAM ticket.
 * This keeps password checking separate from the requested command, so the UI
 * does not display "Checking password…" for the command's full runtime.
 */
export function validateSudoPassword(password: string, signal?: AbortSignal): Promise<SudoResult> {
	return spawnSudo(["-S", "-v"], password, signal);
}

/**
 * True when sudo has a valid cached PAM ticket — `sudo -n true` exits 0
 * without prompting. Lets the caller skip the password stage on repeat calls
 * within the system sudoers timeout (default ~15 min).
 */
export async function hasValidTicket(signal?: AbortSignal): Promise<boolean> {
	try {
		const result = await runTool("sudo", ["-n", "true"], { signal });
		return result.code === 0;
	} catch {
		signal?.throwIfAborted();
		return false;
	}
}

/**
 * Run `command` via `sudo -S -- sh -c <command>`, piping `password` to stdin.
 * Drops `-k` so sudo's PAM timestamp cache persists across calls — a valid
 * ticket means an empty `password` still succeeds without a prompt. Returns
 * stdout, stderr (prompt lines stripped), and exit code.
 */
export function runWithSudo(
	command: string,
	password: string,
	signal?: AbortSignal,
): Promise<SudoResult> {
	return spawnSudo(["-S", "--", "sh", "-c", command], password, signal);
}

async function spawnSudo(
	args: string[],
	password: string,
	signal?: AbortSignal,
): Promise<SudoResult> {
	const result = await runTool("sudo", args, { signal, input: `${password}\n` });
	return { stdout: result.stdout, stderr: filterSudoPrompt(result.stderr), code: result.code ?? 1 };
}
