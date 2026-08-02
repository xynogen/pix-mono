import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type ConfirmUI, confirmOverlay } from "@xynogen/pix-pretty/confirm";
import { openProgress, type ProgressHandle, type ProgressUI } from "@xynogen/pix-pretty/progress";
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

export type InstallMethod = "vp" | "bun" | "npm" | "brew" | "native";

export type CommandSpec = {
	command: string;
	args: string[];
	label: string;
};

export function isTransient(output: string): boolean {
	return TRANSIENT_PATTERNS.some((pattern) => pattern.test(output));
}

export function commandFor(method: InstallMethod): CommandSpec | undefined {
	switch (method) {
		case "vp":
			return {
				command: "vp",
				args: ["add", "-g", `${PACKAGE_NAME}@latest`],
				label: `vp add -g ${PACKAGE_NAME}@latest`,
			};
		case "bun":
			return {
				command: "bun",
				args: ["add", "-g", `${PACKAGE_NAME}@latest`],
				label: `bun add -g ${PACKAGE_NAME}@latest`,
			};
		case "npm":
			return {
				command: "npm",
				args: ["install", "-g", `${PACKAGE_NAME}@latest`],
				label: `npm install -g ${PACKAGE_NAME}@latest`,
			};
		case "brew":
			return {
				command: "/bin/sh",
				args: ["-lc", "brew upgrade pi-coding-agent || brew upgrade pi"],
				label: "brew upgrade pi-coding-agent || brew upgrade pi",
			};
		case "native":
			return undefined;
	}
}

export function formatUpdateSummary(before: string, after: string, attempts: number): string {
	const changed = before !== after && before !== "unknown" && after !== "unknown";
	const summary = changed ? `Pi updated: ${before} → ${after}` : `Pi is up to date (${after}).`;
	return attempts > 1 ? `${summary} Retried ${attempts - 1} transient failure(s).` : summary;
}

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
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

export async function resolveCommand(command: string, pi: ExtensionAPI) {
	const result = await pi.exec("/bin/sh", ["-lc", `command -v ${command} || true`], {
		timeout: 10_000,
	});
	return result.stdout.trim().split("\n")[0] || undefined;
}

export async function currentVersion(pi: ExtensionAPI) {
	const result = await pi.exec("pi", ["--version"], { timeout: 10_000 });
	return result.stdout.trim() || result.stderr.trim() || "unknown";
}

export async function detectInstallMethod(pi: ExtensionAPI): Promise<InstallMethod> {
	// Resolve pi path + realpath + all fallback command probes in parallel.
	const [piPath, vpPath, bunPath, npmPath, brewPath] = await Promise.all([
		resolveCommand("pi", pi),
		resolveCommand("vp", pi),
		resolveCommand("bun", pi),
		resolveCommand("npm", pi),
		resolveCommand("brew", pi),
	]);

	const realPiPath = piPath
		? (
				await pi.exec("/bin/sh", ["-lc", `realpath ${piPath} 2>/dev/null || printf %s ${piPath}`], {
					timeout: 10_000,
				})
			).stdout.trim()
		: undefined;

	if (piPath?.includes("/.vite-plus/") || realPiPath?.includes("/.vite-plus/")) return "vp";
	if (piPath?.includes("/.bun/") || realPiPath?.includes("/.bun/")) return "bun";
	if (
		piPath?.includes("/Homebrew/") ||
		piPath?.includes("/homebrew/") ||
		realPiPath?.includes("/Homebrew/") ||
		realPiPath?.includes("/homebrew/")
	)
		return "brew";

	if (piPath) {
		const hasGlobalNpm = await pi.exec(
			"/bin/sh",
			[
				"-lc",
				`p=${piPath}; i=0; while [ $i -lt 5 ]; do d=$(dirname "$p"); [ -d "$d/node_modules/${PACKAGE_NAME}" ] && exit 0; p=$d; i=$((i+1)); done; exit 1`,
			],
			{ timeout: 10_000 },
		);
		if ((hasGlobalNpm.code ?? 1) === 0) return "npm";
	}

	// Fall back to whichever package manager was found.
	if (vpPath) return "vp";
	if (bunPath) return "bun";
	if (npmPath) return "npm";
	if (brewPath) return "brew";
	return "native";
}

/** Backoff delay between retries. Injectable so tests can skip the real wait. */
export type Sleep = (ms: number) => Promise<void>;

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runWithRetry(pi: ExtensionAPI, spec: CommandSpec, sleep: Sleep = realSleep) {
	let lastOutput = "";
	for (let attempt = 1; attempt <= 3; attempt++) {
		// nice -n 19: deprioritize the install so the TUI keeps echoing keystrokes.
		const result = await pi.exec("nice", ["-n", "19", spec.command, ...spec.args], {
			timeout: ioTimeoutMs(),
		});
		lastOutput = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
		if ((result.code ?? 0) === 0) return { ok: true, output: lastOutput, attempts: attempt };
		if (attempt === 3 || !isTransient(lastOutput))
			return { ok: false, output: lastOutput, attempts: attempt };
		await sleep(attempt * 1500);
	}
	return { ok: false, output: lastOutput, attempts: 3 };
}

async function updatePi(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	progress?: ProgressHandle,
): Promise<boolean> {
	await (ctx as ExtensionCommandContext & { waitForIdle?: () => Promise<void> }).waitForIdle?.();

	// Grab current version + detect install method concurrently.
	const [before, method] = await Promise.all([
		currentVersion(pi).catch(() => "unknown"),
		detectInstallMethod(pi),
	]);
	const spec = commandFor(method);

	if (!spec) {
		ctx.ui.notify(
			`Pi ${before}; install method appears native. Please update the native binary manually.`,
			"warning",
		);
		return false;
	}

	progress?.setLabel(`Updating Pi via ${method}…`);
	const result = await runWithRetry(pi, spec);
	const after = await currentVersion(pi).catch(() => "unknown");

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

async function updatePackages(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	progress?: ProgressHandle,
) {
	progress?.setLabel("Updating pi packages…");
	const result = await pi.exec("nice", ["-n", "19", "pi", "update", "--extensions"], {
		timeout: ioTimeoutMs(),
	});
	const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
	if ((result.code ?? 0) !== 0) {
		ctx.ui.notify(`Pi package update failed. ${output || "No output."}`, "error");
		return;
	}
	ctx.ui.notify("Pi packages updated.", "info");
}

async function updateAll(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
	if (ctx.hasUI) {
		const ok = await confirmOverlay(ctx.ui as unknown as ConfirmUI, {
			title: "Update Pi & extensions?",
			body: ["Pi will close when the update finishes — relaunch to apply."],
		});
		if (!ok) {
			ctx.ui.notify("Update cancelled.", "info");
			return;
		}
	}
	// A focused progress overlay owns input for the whole update, so keystrokes
	// are swallowed instead of echoing out of order while the heavy install
	// subprocesses compete with the TUI. Steps run serially + `nice`-d.
	const progress = ctx.hasUI
		? openProgress(ctx.ui as unknown as ProgressUI, "Updating Pi & extensions")
		: undefined;
	try {
		await updatePi(pi, ctx, progress);
		await updatePackages(pi, ctx, progress);
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
			await updateAll(pi, ctx);
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
