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
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerAsk from "@xynogen/pix-ask";
import registerBash from "@xynogen/pix-bash/extension";
import registerCommands from "@xynogen/pix-commands/extension";
import registerData from "@xynogen/pix-data";
import registerDiagnostics from "@xynogen/pix-diagnostics/extension";
import registerDisplay from "@xynogen/pix-display";
import registerEdit from "@xynogen/pix-edit/extension";
import registerFind from "@xynogen/pix-find/extension";
import registerFooter from "@xynogen/pix-footer/extension";
import registerGate from "@xynogen/pix-gate";
import registerGrep from "@xynogen/pix-grep/extension";
import registerLs from "@xynogen/pix-ls/extension";
import registerModels from "@xynogen/pix-models/extension";
import registerNudge from "@xynogen/pix-nudge/extension";
import registerOptimizer from "@xynogen/pix-optimizer";
import registerPowerShell from "@xynogen/pix-powershell/extension";
import registerPretty from "@xynogen/pix-pretty";
import registerPrompts from "@xynogen/pix-prompts/extension";
import registerRead from "@xynogen/pix-read/extension";
import registerRuntime from "@xynogen/pix-runtime";
import registerSkills from "@xynogen/pix-skills";
import registerSubagent from "@xynogen/pix-subagent/extension";
import registerTodo from "@xynogen/pix-todo";
import registerUpdate from "@xynogen/pix-update/extension";
import registerWelcome from "@xynogen/pix-welcome/extension";
import registerWrite from "@xynogen/pix-write/extension";
import registerCompaction from "./compaction.ts";
import deferNonCoreTools from "./defer-tools.ts";
import registerPlanMode from "./plan-mode.ts";

type PixExtension = (pi: ExtensionAPI) => void | Promise<void>;

// Compile-time boundary: every member must accept the Pi host contract.
const MEMBERS = [
	// Must run first: it wraps registerTool so non-core member tools register deferred.
	deferNonCoreTools,
	// pix-runtime owns pix.json (init/reload/flush) and the /pix settings command.
	// It must run first so every config consumer below reads a live runtime.
	registerRuntime,
	// pix-data warms model caches (modelgrep + BenchLM).
	registerData,
	// pix-pretty seeds the global icon mode (initIconMode) and registers
	// FFF commands. It must run before icon() consumers (footer,
	// display, models, welcome, optimizer) so the mode is set when they paint.
	registerPretty,
	registerWelcome,
	registerFooter,
	registerModels,
	registerUpdate,
	registerCommands,
	registerNudge,
	registerDiagnostics,
	registerDisplay,
	registerPrompts,
	registerSkills,
	registerRead,
	registerWrite,
	registerEdit,
	registerFind,
	registerGrep,
	registerLs,
	registerBash,
	// No-op unless Windows AND the user enabled Pi's optional `powershell` tool.
	registerPowerShell,
	registerTodo,
	registerAsk,
	registerOptimizer,
	registerGate,
	registerSubagent,
	// Custom compaction: replaces pi's built-in summary + trigger (reads
	// compaction section; runs after runtime is live).
	registerCompaction,
	// /plan: plan manager modal. Plan mode (read + bash + write to .pi/plans) turns on
	// for new/edit. Tab in an empty prompt, or ctrl+alt+p, toggles it.
	registerPlanMode,
] satisfies readonly PixExtension[];

export default async function (pi: ExtensionAPI): Promise<void> {
	for (const register of MEMBERS) await register(pi);
}
