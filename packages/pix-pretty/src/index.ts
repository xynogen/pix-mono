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
import { registerFffCommands } from "./commands/fff.js";
import { fffState } from "./fff.js";
import { clearHighlightCache } from "./highlight.js";
import { initIconMode } from "./icon-persist.js";
import type { PiPrettyApi } from "./types.js";

export default function piPrettyExtension(pi: ExtensionAPI): void {
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
