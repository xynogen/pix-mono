/**
 * pix-display — Pi core extension: inline chips, thinking, and code-block display.
 *
 * Entry point: activates inline-chip, thinking, and code-block extensions.
 * Terminal-only rendering behavior stays inactive outside TUI mode.
 *
 * Modules:
 *   inline-chips.ts  Installs the shared InlineChipEditor
 *   thinking.ts      Leaked reasoning tag → native thinking content blocks
 *   code-blocks.ts   Framed, syntax-highlighted code fences in LLM output
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import codeBlocksExtension from "./code-blocks.js";
import inlineChipsExtension from "./inline-chips.js";
import thinkingExtension from "./thinking.js";

export default function pixDisplayExtension(pi: ExtensionAPI): void {
	inlineChipsExtension(pi);
	thinkingExtension(pi);
	codeBlocksExtension(pi);
}
