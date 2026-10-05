import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type ConfirmUI, confirmOverlay } from "@xynogen/pix-pretty/confirm";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { openProgress, type ProgressHandle, type ProgressUI } from "@xynogen/pix-pretty/progress";
import { getErrorMessage } from "@xynogen/pix-pretty/utils";
import { SPINNER } from "@xynogen/pix-pretty/widget-format";
import { runTool } from "@xynogen/pix-runtime/exec";
import { ioTimeoutMs } from "@xynogen/pix-runtime/io";
// ─── Pure logic (exported for tests) ─────────────────────────────────────────

export const PACKAGE_NAME = "@earendil-works/pi-coding-agent";

// Canonical pix-mono installer. Re-running it is idempotent (Pi install + opt-in
// prompts), so it doubles as the extension updater: it refreshes every
// @xynogen/pix-* package from npm.
export const PIX_INSTALL_URL =
	"https://raw.githubusercontent.com/xynogen/pix-mono/main/scripts/install.sh";
export const PIX_UNINSTALL_URL =
	"https://raw.githubusercontent.com/xynogen/pix-mono/main/scripts/uninstall.sh";
// README upgrade path: uninstall then reinstall, so stale/renamed packages from
// breaking changes are cleared before the fresh install.
export const PIX_INSTALL_COMMAND = `curl -fsSL ${PIX_UNINSTALL_URL} | sh && curl -fsSL ${PIX_INSTALL_URL} | sh`;

const TRANSIENT_PATTERNS = [
	/eai_again/i,
	/etimedout/i,
	/econnreset/i,
	/econnrefused/i,
	/socket hang up/i,
	/network/i,
	/timeout/i,
	/temporar/i,
	/too many requests/i,
	/\b429\b/,
	/\b502\b/,
	/\b503\b/,
	/\b504\b/,
];

export type CommandSpec = {
	command: string;
	args: string[];
	label: string;
};

export function isTransient(output: string): boolean {
	return TRANSIENT_PATTERNS.some((pattern) => pattern.test(output));
}

/**
 * Pi updates itself: it detects its own install method (bun/npm/pnpm/yarn),
 * adds --ignore-scripts, handles package renames, and prints a manual fallback
 * when it cannot self-update.
 */
export const PI_SELF_UPDATE: CommandSpec = {
	command: "pi",
	args: ["update", "--self"],
	label: "pi update --self",
};

export function formatUpdateSummary(before: string, after: string, attempts: number): string {
	const changed = before !== after && before !== "unknown" && after !== "unknown";
	const summary = changed ? `Pi updated: ${before} → ${after}` : `Pi is up to date (${after}).`;
	return attempts > 1 ? `${summary} Retried ${attempts - 1} transient failure(s).` : summary;
}

export { SPINNER } from "@xynogen/pix-pretty/widget-format";

// 250ms (not 80ms): with up to 3 concurrent spinners during updateAll, a fast
// cadence floods the TUI render queue and starves keystroke echo (typed chars
// render out of order). 250ms still animates smoothly for a multi-minute op.
const SPINNER_INTERVAL_MS = 250;

type StatusUI = { setStatus(key: string, text: string | undefined): void };

// Ticks a spinner status line while `work` runs; always clears it after.
// `key` must be unique per concurrent caller — updateAll runs two of these in
// parallel, so a shared key would let one clear the other's line.
export async function withSpinner<T>(
	ui: StatusUI,
	key: string,
	label: string,
	work: () => Promise<T>,
): Promise<T> {
	let frame = 0;
	ui.setStatus(key, `${SPINNER[0]} ${label}`);
	const timer = setInterval(() => {
		frame = (frame + 1) % SPINNER.length;
		ui.setStatus(key, `${SPINNER[frame]} ${label}`);
	}, SPINNER_INTERVAL_MS);
	try {
		return await work();
	} finally {
		clearInterval(timer);
		ui.setStatus(key, undefined);
	}
}

/** Result shape shared with Pi's pi.exec (tests inject a fake). */
export interface ExecOutput {
	stdout: string;
	stderr: string;
	code?: number | null;
}

/**
 * How update commands run. Default: pix-runtime, so pi resolves
 * through binary.json and Windows .cmd shims (pi.cmd) work.
 */
export type Exec = (
	command: string,
	args: string[],
	opts: { timeout?: number },
) => Promise<ExecOutput>;

export const runtimeExec: Exec = (command, args, opts) =>
	runTool(command, args, { timeoutMs: opts.timeout });

/** Pi's ExtensionAPI (tests) or an Exec; both end up as an Exec. */
function asExec(runner: ExtensionAPI | Exec): Exec {
	return typeof runner === "function" ? runner : (c, a, o) => runner.exec(c, a, o);
}

export async function currentVersion(runner: ExtensionAPI | Exec = runtimeExec) {
	const result = await asExec(runner)("pi", ["--version"], { timeout: 10_000 });
	return result.stdout.trim() || result.stderr.trim() || "unknown";
}

/** Backoff delay between retries. Injectable so tests can skip the real wait. */
export type Sleep = (ms: number) => Promise<void>;

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runWithRetry(
	runner: ExtensionAPI | Exec,
	spec: CommandSpec,
	sleep: Sleep = realSleep,
) {
	const exec = asExec(runner);
	let lastOutput = "";
	for (let attempt = 1; attempt <= 3; attempt++) {
		const result = await exec(spec.command, spec.args, { timeout: ioTimeoutMs() });
		lastOutput = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
		if ((result.code ?? 0) === 0) return { ok: true, output: lastOutput, attempts: attempt };
		if (attempt === 3 || !isTransient(lastOutput))
			return { ok: false, output: lastOutput, attempts: attempt };
		await sleep(attempt * 1500);
	}
	return { ok: false, output: lastOutput, attempts: 3 };
}

async function updatePi(ctx: ExtensionCommandContext, progress?: ProgressHandle): Promise<boolean> {
	await (ctx as ExtensionCommandContext & { waitForIdle?: () => Promise<void> }).waitForIdle?.();

	const before = await currentVersion().catch(() => "unknown");

	progress?.setLabel(`Updating Pi (${PI_SELF_UPDATE.label})…`);
	const result = await runWithRetry(runtimeExec, PI_SELF_UPDATE).catch((err: unknown) => ({
		ok: false,
		output: getErrorMessage(err),
		attempts: 1,
	}));
	const after = await currentVersion().catch(() => "unknown");

	if (!result.ok) {
		ctx.ui.notify(
			`Pi update failed after ${result.attempts} attempt(s). ${result.output || "No output."}`,
			"error",
		);
		return false;
	}

	ctx.ui.notify(formatUpdateSummary(before, after, result.attempts), "info");
	return true;
}

async function updatePackages(ctx: ExtensionCommandContext, progress?: ProgressHandle) {
	progress?.setLabel("Updating extensions (pi update --extensions)…");
	const result = await runtimeExec("pi", ["update", "--extensions"], {
		timeout: ioTimeoutMs(),
	}).catch((err: unknown) => ({
		stdout: "",
		stderr: getErrorMessage(err),
		code: 1,
	}));
	const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
	if ((result.code ?? 0) !== 0) {
		ctx.ui.notify(`Pi package update failed. ${output || "No output."}`, "error");
		return;
	}
	ctx.ui.notify("Pi packages updated.", "info");
}

async function updateAll(ctx: ExtensionCommandContext) {
	if (ctx.hasUI) {
		// SAFETY: ctx.ui structurally provides the ConfirmUI surface (custom/theme);
		// the host's UI type is wider, so we narrow to the subset confirmOverlay uses.
		const ok = await confirmOverlay(ctx.ui as unknown as ConfirmUI, {
			icon: icon("update"),
			title: "Update Pi & Extensions?",
			body: ["Pi will close when the update finishes — relaunch to apply."],
		});
		if (!ok) {
			ctx.ui.notify("Update cancelled.", "info");
			return;
		}
	}
	// A focused progress overlay owns input for the whole update, so keystrokes
	// are swallowed instead of echoing out of order while the heavy install
	// subprocesses compete with the TUI. Steps run serially.
	// SAFETY: ctx.ui structurally provides the ProgressUI surface; the host UI
	// type is wider, so we narrow to the subset openProgress uses.
	const progress = ctx.hasUI
		? openProgress(ctx.ui as unknown as ProgressUI, "Updating Pi & extensions")
		: undefined;
	try {
		await updatePi(ctx, progress);
		await updatePackages(ctx, progress);
	} finally {
		progress?.close();
	}
	// Updates land on disk but need a fresh process to load. Quit so the
	// next launch picks up new Pi + extensions; shutdown defers until idle.
	ctx.ui.notify("Update complete. Closing Pi — relaunch to apply.", "warning");
	(ctx as ExtensionCommandContext & { shutdown?: () => void }).shutdown?.();
}

export default function (pi: ExtensionAPI) {
	(
		pi as ExtensionAPI & {
			registerFlag: (name: string, opts: unknown) => void;
		}
	).registerFlag("update", {
		description: "Update Pi, pix extensions, and pi packages",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("update", {
		description: "Update Pi, pix extensions, and pi packages",
		handler: async (_args, ctx) => {
			await updateAll(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const flags = pi as ExtensionAPI & {
			getFlag?: (name: string) => boolean;
			sendUserMessage?: (message: string, opts?: unknown) => void;
		};
		if (!flags.getFlag?.("update")) return;
		flags.sendUserMessage?.("/update", { deliverAs: "followUp" });
		ctx.ui.notify("Queued /update from --update", "info");
	});
}
