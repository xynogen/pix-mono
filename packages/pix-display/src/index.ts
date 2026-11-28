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
 *   code-copy.ts     The `copy` button on a code frame's header row
 *   directives.ts    `::card[…]`, charts and inline directives in LLM output
 *   fold.ts          `::fold[Title]` … `::fold` sections, opened by click or Pi's expand key
 *   tables.ts        Themed Markdown tables with column alignment
 */

import { registerChips } from "@xynogen/pix-pretty/chips";
import type { ExtensionAPI } from "@xynogen/pix-runtime/host";
import { once } from "@xynogen/pix-runtime/once";

import codeBlocksExtension from "./code-blocks.ts";
import { initCodeCopy } from "./code-copy.ts";
import directivesExtension from "./directives.ts";
import { followFoldInput, initFolds } from "./fold.ts";
import { hasDisplayMath, offerMathInstall, startMath } from "./math.ts";
import { hasMermaid, offerMermaidInstall, startMermaid } from "./mermaid.ts";
import tablesExtension from "./tables.ts";
import thinkingExtension from "./thinking.ts";
import workingExtension from "./working.ts";

export default async function pixDisplayExtension(pi: ExtensionAPI): Promise<void> {
	once(pi, "pix-display", () => {
		registerChips(pi);
		thinkingExtension(pi);
		codeBlocksExtension(pi);
		tablesExtension(pi);
		directivesExtension(pi);
		workingExtension(pi);
		followFoldInput();
		pi.on("session_start", (_event, ctx) => {
			if (ctx.mode !== "tui") return;
			initFolds(ctx.ui);
			initCodeCopy(ctx.ui);
		});
		pi.on("agent_end", (event, ctx) => {
			if (ctx.mode !== "tui") return;
			const fail = (what: string) => (err: unknown) =>
				ctx.ui.notify(`${what} install failed: ${String(err)}`, "error");
			// Not awaited: an install prompt must not hold up the next turn. One prompt at a
			// time, so Mermaid waits for the math prompt to finish.
			void (async () => {
				if (hasDisplayMath(event.messages))
					await offerMathInstall(ctx.ui).catch(fail("LaTeX engine"));
				if (hasMermaid(event.messages))
					await offerMermaidInstall(ctx.ui).catch(fail("Mermaid renderer"));
			})();
		});
	});
	// Markdown caches each render, so the engines must be ready before the transcript draws.
	await Promise.all([startMath(), startMermaid()]);
}
