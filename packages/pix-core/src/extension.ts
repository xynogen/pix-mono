/**
 * pix-core — aggregator extension.
 *
 * Pi activates extensions per installed package via its `pi.extensions`
 * manifest; it does NOT walk npm dependencies. So a meta-package can only
 * activate its members by importing each one's extension factory and invoking
 * it against the same `pi` host.
 *
 * Every member exposes a default-exported `(pi) => void` factory through its
 * public root or `./extension` subpath. One `pi install npm:@xynogen/pix-core`
 * then boots all of them.
 *
 * Members load by dynamic import, so a missing or broken member is skipped and
 * reported on session_start instead of stopping Pi from starting.
 */

import { getErrorMessage } from "@xynogen/pix-pretty/utils";
import { readFileSync } from "@xynogen/pix-runtime/fs";
import type { ExtensionAPI } from "@xynogen/pix-runtime/host";
import { once } from "@xynogen/pix-runtime/once";
import registerCompaction from "./compaction.ts";
import deferNonCoreTools from "./defer-tools.ts";
import registerPlanMode from "./plan-mode.ts";

type PixExtension = (pi: ExtensionAPI) => void | Promise<void>;

// Local factories run directly. Strings are member specifiers, imported at load time.
const MEMBERS: readonly (PixExtension | string)[] = [
	// Must run first: it wraps registerTool so non-core member tools register deferred.
	deferNonCoreTools,
	// pix-runtime owns pix.json (init/reload/flush) and the /pix settings command.
	// It must run first so every config consumer below reads a live runtime.
	"@xynogen/pix-runtime",
	// pix-data warms model caches (modelgrep + BenchLM).
	"@xynogen/pix-data",
	// pix-pretty seeds the global icon mode (initIconMode) and registers
	// FFF commands. It must run before icon() consumers (footer,
	// display, models, welcome, optimizer) so the mode is set when they paint.
	"@xynogen/pix-pretty",
	"@xynogen/pix-welcome/extension",
	"@xynogen/pix-footer/extension",
	"@xynogen/pix-models/extension",
	"@xynogen/pix-update/extension",
	"@xynogen/pix-commands/extension",
	"@xynogen/pix-nudge/extension",
	"@xynogen/pix-diagnostics/extension",
	"@xynogen/pix-display",
	"@xynogen/pix-prompts/extension",
	"@xynogen/pix-skills",
	"@xynogen/pix-read/extension",
	"@xynogen/pix-write/extension",
	"@xynogen/pix-edit/extension",
	"@xynogen/pix-find/extension",
	"@xynogen/pix-grep/extension",
	"@xynogen/pix-ls/extension",
	"@xynogen/pix-bash/extension",
	// Enabled automatically on native Windows; not registered on other hosts.
	"@xynogen/pix-powershell/extension",
	"@xynogen/pix-todo",
	"@xynogen/pix-ask",
	"@xynogen/pix-optimizer",
	"@xynogen/pix-gate",
	"@xynogen/pix-notify",
	"@xynogen/pix-subagent/extension",
	// Custom compaction: replaces pi's built-in summary + trigger (reads
	// compaction section; runs after runtime is live).
	registerCompaction,
	// /plan: plan manager modal. Plan mode (read + bash + write to .pi/plans) turns on
	// for new/edit. Tab in an empty prompt, or ctrl+alt+p, toggles it.
	registerPlanMode,
];

async function resolveMember(member: PixExtension | string): Promise<PixExtension> {
	if (typeof member !== "string") return member;
	const mod: { default?: unknown } = await import(member);
	if (typeof mod.default !== "function") throw new Error("no default factory export");
	return mod.default as PixExtension;
}

export default async function (pi: ExtensionAPI): Promise<void> {
	once(pi, "pix-core", () => {
		const { version } = JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf8"),
		);
		pi.events?.on("pix:core-version", (query) => {
			if (query && typeof query === "object" && "version" in query) {
				query.version = typeof version === "string" ? version : "";
			}
		});
	});
	const failed: string[] = [];
	// ponytail: sequential on purpose. Parallel import() under Pi's jiti loader returns broken modules.
	for (const [i, member] of MEMBERS.entries()) {
		const name = typeof member === "string" ? member : member.name || `#${i}`;
		try {
			await (await resolveMember(member))(pi);
		} catch (error) {
			// Module errors append a multi-line require stack; the first line names the cause.
			failed.push(`${name}: ${getErrorMessage(error).split("\n")[0]}`);
		}
	}
	if (failed.length === 0) return;
	pi.on("session_start", (_event, ctx) =>
		ctx.ui.notify(
			`pix-core skipped ${failed.length} member(s):\n${failed.join("\n")}\nReinstall pix-core, or run \`bun install\` in a dev checkout.`,
			"warning",
		),
	);
}
