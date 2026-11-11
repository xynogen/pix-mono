import {
	CursorStore,
	fffDestroy,
	fffEnsureFinder,
	fffState,
	getPiPrettyFffDir,
} from "@xynogen/pix-pretty/fff";
import { showTransientMessage } from "@xynogen/pix-pretty/transient-error";
import { Text } from "@xynogen/pix-pretty/tui";
import type { OptionalFffModule } from "@xynogen/pix-pretty/types";
import {
	getErrorMessage,
	linkedShortPath,
	viewportTextConstructor,
} from "@xynogen/pix-pretty/utils";
import { mkdirSync } from "@xynogen/pix-runtime/fs";
import {
	createGrepToolDefinition,
	createGrepTool as createGrepToolFallback,
	type ExtensionAPI,
	type ExtensionContext,
} from "@xynogen/pix-runtime/host";
import { once } from "@xynogen/pix-runtime/once";
import { homeDir } from "@xynogen/pix-runtime/paths";
import { registerGrepTool } from "./grep.ts";

export default function pixGrepExtension(pi: ExtensionAPI): void {
	once(pi, "pix-grep", () => {
		const createGrepTool = createGrepToolDefinition ?? createGrepToolFallback;
		if (!createGrepTool) return;

		const cwd = process.cwd();
		const home = homeDir();
		const cursorStore = new CursorStore();

		// ── FFF init ────────────────────────────────────────────────────────
		// pix-grep owns the FFF session lifecycle. pix-find shares the same
		// fffState singleton (module-level in pix-pretty/fff.ts) so both tools
		// benefit from a single finder instance without double-initializing.

		try {
			fffState.module = require("@ff-labs/fff-node") as OptionalFffModule;
			fffState.dbDir = getPiPrettyFffDir();
			try {
				mkdirSync(fffState.dbDir, { recursive: true });
			} catch {}
		} catch {
			/* fff-node not installed — grep falls back to SDK ripgrep */
		}

		pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
			if (!fffState.module) {
				try {
					// require avoids static type dep — fff-node is optional
					fffState.module = require("@ff-labs/fff-node") as OptionalFffModule;
				} catch {
					/* fff-node not installed — no-op */
				}
			}
			if (!fffState.module) return;

			if (!fffState.dbDir) {
				fffState.dbDir = getPiPrettyFffDir();
				try {
					mkdirSync(fffState.dbDir, { recursive: true });
				} catch {}
			}

			try {
				await fffEnsureFinder(ctx.cwd);
				if (fffState.partialIndex && ctx.ui) {
					showTransientMessage(
						ctx.ui,
						"FFF: scan timed out — using partial index. Run /fff-rescan when ready.",
						"warning",
					);
				}
			} catch (error: unknown) {
				if (ctx.ui)
					showTransientMessage(ctx.ui, `FFF init failed: ${getErrorMessage(error)}`, "error");
			}
		});

		pi.on("session_shutdown", async () => {
			fffDestroy();
		});

		registerGrepTool(pi, createGrepTool, {
			cwd,
			sp: (p: string) => linkedShortPath(cwd, home, p),
			TextComponent: viewportTextConstructor(Text),
			fffState,
			cursorStore,
		});
	});
}
