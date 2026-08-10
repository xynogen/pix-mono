import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bindHerdrNotify } from "./herdr-notify.ts";
import { bindAgentStateEvents, resetAgentState } from "./herdr-state.ts";
import { once } from "./once.ts";
import { registerPixCommand } from "./pix-command.ts";
import { pixRuntime } from "./runtime.ts";

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
		const unbindHerdrNotify = bindHerdrNotify(pi.events);

		let initialized = false;
		pi.on("session_start", async () => {
			if (initialized) {
				await runtime.reload({ origin: "reload", source: "session_start" });
			} else {
				initialized = true;
				await runtime.init({ origin: "init", source: "session_start" });
			}
			surfaceDiagnostics(pi, runtime);
		});

		pi.on("session_shutdown", async () => {
			resetAgentState(pi.events);
			unbindHerdrNotify();
			unbindAgentState();
			await runtime.flush();
		});
	});
}

/** Aggregate error-severity diagnostics into at most one notification. */
function surfaceDiagnostics(pi: ExtensionAPI, runtime: ReturnType<typeof pixRuntime>): void {
	const errors = runtime.diagnostics().filter((d) => d.severity === "error");
	if (errors.length === 0) return;
	const ui = (pi as unknown as { ui?: { notify?(m: string, t?: string): void } }).ui;
	const msg = `pix config: ${errors.length} issue(s) — see ${runtime.path}`;
	ui?.notify?.(msg, "warning");
}
