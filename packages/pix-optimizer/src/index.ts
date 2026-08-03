/**
 * pix-optimizer — token-optimization suite for Pi Coding Agent.
 *
 * Three tools, combined into one extension + one command:
 *   - caveman:  terse-output system prompt
 *   - rtk:      prefixes shell commands with `rtk` + injects RTK prompt
 *   - ponytail: lazy-senior-dev system prompt (minimal code, YAGNI)
 *
 * They share ONE status-bar cell (all three icons always shown — dimmed when
 * off, accented when on; icon style is nerd/unicode/ascii, set via /optimizer)
 * and ONE command (/optimizer — an interactive overlay). index.ts wires
 * lifecycle hooks via each module, then registers the overlay command.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { caveman } from "./caveman.ts";
import { registerOptCommand } from "./opt.ts";
import { ponytail } from "./ponytail.ts";
import { rtk } from "./rtk.ts";
import { type OptimizerHandle, OptimizerStatus, type OptimizerTool } from "./status.ts";
import { filterModelWarnings } from "./tool-result-filter.ts";

export default function optimizer(pi: ExtensionAPI) {
	// Icons follow the global pix-pretty mode (set via /pix); no local state.
	const status = new OptimizerStatus();

	// Each module registers its own lifecycle hooks and returns a handle the
	// /optimizer overlay renders + drives.
	const handles: Record<OptimizerTool, OptimizerHandle> = {
		caveman: caveman(pi, status),
		rtk: rtk(pi, status),
		ponytail: ponytail(pi, status),
	};

	registerOptCommand(pi, handles, status);

	// Strip model-guidance warnings injected by pi-lens into tool_result content.
	// These strings (BLIND WRITE, THRASHING) are directives for the LLM, not
	// information for the user — filtering them here hides them from the TUI
	// without affecting the model (it already acted on the write/edit result).
	pi.on("tool_result", async (event) => {
		const filtered = filterModelWarnings(event.content);
		if (filtered === event.content) return undefined;
		return { content: filtered };
	});
}
