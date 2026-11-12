import type { ExtensionAPI, ExtensionContext } from "@xynogen/pix-runtime/host";
import {
	logoutServer,
	openMcpPanel,
	openMcpSetup,
	reconnectServers,
	showStatus,
	showTools,
} from "./commands.ts";
import type { McpExtensionState } from "./state.ts";

/** `/mcp [reconnect|tools|setup|logout] …` — no subcommand opens the panel (status when headless). */
export async function runMcpCommand(
	args: string | undefined,
	state: McpExtensionState,
	pi: ExtensionAPI,
	ctx: ExtensionContext & { reload(): Promise<void> },
	configPath: string | undefined,
): Promise<void> {
	const parts = args?.trim()?.split(/\s+/) ?? [];
	const subcommand = parts[0] ?? "";
	const rest = parts.slice(1).join(" ");
	switch (subcommand) {
		case "reconnect":
			await reconnectServers(state, ctx, parts[1]);
			return;
		case "tools":
			await showTools(state, ctx);
			return;
		case "setup": {
			const result = await openMcpSetup(state, pi, ctx, configPath, "setup");
			if (result?.configChanged) await ctx.reload();
			return;
		}
		case "logout":
			if (!rest) {
				if (ctx.hasUI) ctx.ui.notify("Usage: /mcp logout <server>", "error");
				return;
			}
			await logoutServer(rest, state, ctx);
			return;
		default:
			if (!ctx.hasUI) {
				await showStatus(state, ctx);
				return;
			}
			if ((await openMcpPanel(state, pi, ctx, configPath))?.configChanged) await ctx.reload();
	}
}
