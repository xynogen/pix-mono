/**
 * pix-display — Pi core extension: inline chips, thinking, and code-block display.
 *
 * Entry point: activates inline-chip, thinking, and code-block extensions.
 * Terminal-only rendering behavior stays inactive outside TUI mode.
 *
 * Modules:
 *   @xynogen/pix-pretty/chips  Inline chips (tag format, editor, sent messages)
 *   thinking.ts      Leaked reasoning tag → native thinking content blocks
 *   code-blocks.ts   Framed, syntax-highlighted code fences in LLM output
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerChips } from "@xynogen/pix-pretty/chips";
import { once } from "@xynogen/pix-runtime/once";

import codeBlocksExtension from "./code-blocks.ts";
import thinkingExtension from "./thinking.ts";
import workingExtension from "./working.ts";

export default function pixDisplayExtension(pi: ExtensionAPI): void {
	once(pi, "pix-display", () => {
		registerChips(pi);
		thinkingExtension(pi);
		codeBlocksExtension(pi);
		workingExtension(pi);
	});
}
