import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

async function clearCache(_pi: ExtensionAPI, ctx: ExtensionCommandContext) {
	ctx.ui.notify("Clearing ~/.cache/pi", "info");
	try {
		await rm(join(homedir(), ".cache", "pi"), { recursive: true, force: true });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		ctx.ui.notify(`Cache clear failed. ${msg}`, "error");
		return;
	}
	ctx.ui.notify("~/.cache/pi cleared. Run /reload to apply changes.", "warning");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("clear", {
		description: "Remove ~/.cache/pi and reload",
		handler: async (_args, ctx) => {
			await clearCache(pi, ctx);
		},
	});
}
