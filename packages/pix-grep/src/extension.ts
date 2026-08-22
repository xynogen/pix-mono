import { mkdirSync } from "node:fs";
import { join } from "node:path";

import {
	createGrepToolDefinition,
	createGrepTool as createGrepToolFallback,
	type ExtensionAPI,
	type ExtensionContext,
	type GrepToolInput,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
	CursorStore,
	fffDestroy,
	fffEnsureFinder,
	fffState,
	getPiPrettyFffDir,
} from "@xynogen/pix-pretty/fff";
import type {
	OptionalFffModule,
	PiPrettyApi,
	TextComponentCtor,
	ToolFactory,
} from "@xynogen/pix-pretty/types";
import { getErrorMessage, shortPath, viewportTextConstructor } from "@xynogen/pix-pretty/utils";
import { once } from "@xynogen/pix-runtime/once";
import { registerGrepTool } from "./grep.js";

export default function pixGrepExtension(pi: ExtensionAPI): void {
	const prettyPi = pi as unknown as PiPrettyApi;
	once(pi, "pix-grep", () => {
		const createGrepTool = (createGrepToolDefinition ??
			createGrepToolFallback) as unknown as ToolFactory<GrepToolInput>;
		if (!createGrepTool) return;

		let TextComponent: TextComponentCtor;
		try {
			TextComponent = require("@earendil-works/pi-tui").Text;
		} catch {
			return;
		}

		const cwd = process.cwd();
		const home = process.env.HOME ?? "";
		const cursorStore = new CursorStore();

		// ── FFF init ────────────────────────────────────────────────────────
		// pix-grep owns the FFF session lifecycle. pix-find shares the same
		// fffState singleton (module-level in pix-pretty/fff.ts) so both tools
		// benefit from a single finder instance without double-initializing.

		try {
			fffState.module = require("@ff-labs/fff-node") as OptionalFffModule;
			const agentDir = getAgentDir?.() ?? join(home, ".pi/agent");
			fffState.dbDir = getPiPrettyFffDir(agentDir);
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
				const agentDir = getAgentDir?.() ?? join(home, ".pi/agent");
				fffState.dbDir = getPiPrettyFffDir(agentDir);
				try {
					mkdirSync(fffState.dbDir, { recursive: true });
				} catch {}
			}

			try {
				await fffEnsureFinder(ctx.cwd);
				if (fffState.partialIndex) {
					ctx.ui?.notify?.(
						"FFF: scan timed out — using partial index. Run /fff-rescan when ready.",
						"warning",
					);
				}
			} catch (error: unknown) {
				ctx.ui?.notify?.(`FFF init failed: ${getErrorMessage(error)}`, "error");
			}
		});

		pi.on("session_shutdown", async () => {
			fffDestroy();
		});

		registerGrepTool(prettyPi, createGrepTool, {
			cwd,
			sp: (p: string) => shortPath(cwd, home, p),
			TextComponent: viewportTextConstructor(TextComponent),
			fffState,
			cursorStore,
		});
	});
}
