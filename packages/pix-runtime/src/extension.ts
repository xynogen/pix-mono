import {
	type BashOperations,
	createLocalBashOperations,
	createLocalPowerShellOperations,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { syncBinaryStore } from "./binaries/store.ts";
import { bindAgentStateEvents, resetAgentState, resetUnattendedState } from "./herdr-state.ts";
import { once } from "./once.ts";
import { registerPixCommand } from "./pix-command.ts";
import { pixRuntime } from "./runtime.ts";
import { userShell } from "./user-shell.ts";

/**
 * Runtime extension entry. Idempotent per `pi` instance: registers `/pix` and
 * session lifecycle hooks, and drives init/reload/flush of the config singleton.
 *
 * Standalone-installable: importing a runtime accessor lazily creates the
 * singleton even if this factory never runs, so the factory only owns the
 * command and lifecycle wiring.
 */
export default function registerRuntime(pi: ExtensionAPI): void {
	once(pi, "pix-runtime", () => {
		const runtime = pixRuntime();

		registerPixCommand(pi, runtime);
		const unbindAgentState = bindAgentStateEvents(pi.events);

		// User `!` commands: PowerShell on Windows, $SHELL on POSIX (zsh gets rc + aliases).
		const shell = userShell();
		// Older Pi has no PowerShell backend. Keep Pi's default shell then.
		const inner =
			shell?.kind === "powershell"
				? createLocalPowerShellOperations?.()
				: shell && createLocalBashOperations({ shellPath: shell.shellPath });
		if (shell && inner) {
			const operations: BashOperations = {
				exec: (command, cwd, options) => inner.exec(shell.wrap(command), cwd, options),
			};
			pi.on("user_bash", () => ({ operations }));
		}

		let initialized = false;
		pi.on("session_start", async () => {
			resetUnattendedState(pi.events);
			if (initialized) {
				await runtime.reload({ origin: "reload", source: "session_start" });
			} else {
				await runtime.init({ origin: "init", source: "session_start" });
				// Set only on success: a failed init retries init (with migrations) next session.
				initialized = true;
			}
			surfaceDiagnostics(pi, runtime);
			// binary.json holds overrides only; drop legacy `null` padding, report bad JSON.
			try {
				const store = syncBinaryStore();
				if (store.error) notifyWarning(pi, `pix: ${store.path} is invalid (${store.error})`);
			} catch {
				/* read-only agent dir: the Binaries tab still resolves without the file */
			}
		});

		pi.on("session_shutdown", async () => {
			resetAgentState(pi.events);
			resetUnattendedState(pi.events);
			unbindAgentState();
			await runtime.flush();
		});
	});
}

/** Aggregate error-severity diagnostics into at most one notification. */
function surfaceDiagnostics(pi: ExtensionAPI, runtime: ReturnType<typeof pixRuntime>): void {
	const errors = runtime.diagnostics().filter((d) => d.severity === "error");
	if (errors.length === 0) return;
	notifyWarning(pi, `pix config: ${errors.length} issue(s) — see ${runtime.path}`);
}

function notifyWarning(pi: ExtensionAPI, msg: string): void {
	const ui = (pi as unknown as { ui?: { notify?(m: string, t?: string): void } }).ui;
	ui?.notify?.(msg, "warning");
}
