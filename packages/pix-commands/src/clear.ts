import { isAbsolute, join, relative } from "node:path";
import { confirmOverlay } from "@xynogen/pix-pretty/confirm";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { getErrorMessage } from "@xynogen/pix-pretty/utils";
import { rm } from "@xynogen/pix-runtime/fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@xynogen/pix-runtime/host";
import { cacheDir, tempDir } from "@xynogen/pix-runtime/paths";

/** Drop a target that sits inside another target: deleting the parent removes it. */
export function outermost(paths: string[]): string[] {
	const inside = (child: string, parent: string) => {
		const rel = relative(parent, child);
		return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
	};
	return paths.filter((p) => !paths.some((q) => inside(p, q)));
}

async function clearCache(_pi: ExtensionAPI, ctx: ExtensionCommandContext) {
	// Only Pi's own files. The temp dir is shared with every other program, so
	// delete jiti's transpile cache inside it, never the temp dir itself.
	// With TMPDIR=~/.cache/pi the jiti dir is inside cacheDir(), so list it once.
	const targets = outermost([cacheDir(), join(tempDir(), "jiti")]);
	if (ctx.hasUI) {
		const ok = await confirmOverlay(ctx.ui, {
			icon: icon("status.warn"),
			title: "Clear the Pi cache?",
			body: ["This deletes:", ...targets.map((t) => `  ${t}`), "Run /reload after to apply."],
			confirmLabel: "Delete",
			denyLabel: "Cancel",
		});
		if (!ok) {
			ctx.ui.notify("Clear cancelled.", "info");
			return;
		}
	}
	ctx.ui.notify(`Clearing ${targets.join(" and ")}`, "info");
	try {
		for (const t of targets) await rm(t, { recursive: true, force: true });
	} catch (err) {
		const msg = getErrorMessage(err);
		ctx.ui.notify(`Cache clear failed. ${msg}`, "error");
		return;
	}
	ctx.ui.notify(`${targets.join(" and ")} cleared. Run /reload to apply changes.`, "warning");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("clear", {
		description: "Remove ~/.cache/pi (asks first)",
		handler: async (_args, ctx) => {
			await clearCache(pi, ctx);
		},
	});
}
