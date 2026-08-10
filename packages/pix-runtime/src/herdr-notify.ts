import { spawn } from "node:child_process";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { PixAgentState, PixAgentStateEvent } from "./herdr-state.ts";

/**
 * Leaf bridge: when the agent enters the `blocked` state (ask_user / gate /
 * sudo waiting on the user), fire a herdr notification so an away-from-pane
 * user gets a sound + popup. Fires only on the transition INTO blocked, never
 * repeatedly. No-op outside a herdr pane; silence with `PIX_HERDR_NOTIFY=0`.
 */
export function bindHerdrNotify(events: EventBus, spawnFn = spawn): () => void {
	// ponytail: gate on HERDR_ENV — herdr's own extension uses the same signal;
	//           outside herdr the CLI would just no-op, so skip the spawn entirely.
	if (process.env.HERDR_ENV !== "1" || process.env.PIX_HERDR_NOTIFY === "0") {
		return () => {};
	}
	let last: PixAgentState | undefined;
	const off = events.on("pix:agent-state", (raw) => {
		const event = raw as PixAgentStateEvent;
		if (event.state === "blocked" && last !== "blocked") {
			notify(event.message ?? "Pi needs your attention", spawnFn);
		}
		last = event.state;
	});
	return off;
}

function notify(message: string, spawnFn: typeof spawn): void {
	try {
		const child = spawnFn("herdr", ["notification", "show", message, "--sound", "request"], {
			stdio: "ignore",
			detached: true,
		});
		child.on("error", () => {}); // herdr not on PATH — ignore
		child.unref();
	} catch {
		// spawn threw synchronously; nothing actionable
	}
}
