/**
 * consent.ts — one-time user consent to install a grammar package.
 *
 * A tool's `execute` receives a Pi UI context. This turns it into a `ConsentFn`
 * for `parseWithGrammar`: it shows a confirm overlay once per package. Without
 * a UI (non-interactive session), it defers — the package installs nothing
 * without a person saying yes.
 */

import { showOverlay } from "@xynogen/pix-pretty/gate-overlay";
import { type ConsentFn, grammarCacheDir } from "./grammars.ts";

// Minimal shape of the execute `ctx` we need. No hard dep on the host type.
export interface ExecuteCtx {
	hasUI?: boolean;
	ui: Parameters<typeof showOverlay>[0];
}

const INSTALL_TIMEOUT_MS = 60_000;

/** Build a consent function that asks once per grammar package. */
export function grammarConsent(ctx?: ExecuteCtx): ConsentFn | undefined {
	if (!ctx?.hasUI) return undefined;
	return async (pkg: string): Promise<boolean> => {
		const result = await showOverlay(ctx.ui, {
			mode: "confirm",
			title: "Install ast-grep grammar",
			body: [
				`This language needs the grammar package:`,
				`  ${pkg}`,
				``,
				`Install it into the pix cache (${grammarCacheDir()})?`,
				`If another grammar is already active, restart the agent after installation.`,
			],
			accent: "accent",
			timeoutMs: INSTALL_TIMEOUT_MS,
			choices: [
				{ value: "yes", label: "Install", description: "Download and use this grammar" },
				{ value: "no", label: "Skip", description: "Do not install; skip this language" },
			],
		});
		return result.action === "approved";
	};
}
