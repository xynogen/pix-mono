/**
 * pix-pretty — Pretty terminal output for pi built-in tools.
 *
 * Primarily a rendering library (highlight/diff/icons/fff, imported by the tool
 * packages). This default export is also a thin Pi extension: on load it inits
 * the pretty theme, clears the highlight cache, and registers the FFF slash
 * commands (/fff-health, /fff-rescan). pix-core activates it for that purpose.
 * UI features (paste chips, thinking blocks) live in pix-display.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { once } from "@xynogen/pix-runtime/once";
import { registerFffCommands } from "./commands/fff.ts";
import { fffState } from "./fff.ts";
import { clearHighlightCache } from "./highlight.ts";
import { initIconMode } from "./icon-persist.ts";
import { installOrderedWidgets } from "./ordered-widgets.ts";
import type { PiPrettyApi } from "./types.ts";

export default function piPrettyExtension(pi: ExtensionAPI): void {
	once(pi, "pix-pretty-widgets", () => {
		let restore: (() => void) | undefined;
		pi.on("session_start", (_event, ctx) => {
			if (ctx.mode === "tui") restore = installOrderedWidgets(ctx.ui);
		});
		pi.on("session_shutdown", () => {
			restore?.();
			restore = undefined;
		});
	});
	const prettyPi = pi as unknown as PiPrettyApi;
	clearHighlightCache();

	// ── Icon mode ───────────────────────────────────────────
	// Seed the global icon mode from pix.json (overrides env default).
	// The /pix settings command lives in pix-data.
	initIconMode();

	// ── FFF slash commands ──────────────────────────────────────────────
	// fffState is a module-level singleton shared with pix-grep/pix-find.
	// Commands become available once pix-grep initialises the finder.
	registerFffCommands(prettyPi, fffState);
}
