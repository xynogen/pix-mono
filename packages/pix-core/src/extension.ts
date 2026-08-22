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
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
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

type PixExtension = (pi: ExtensionAPI) => void;

// Compile-time boundary: every member must accept the Pi host contract.
const MEMBERS = [
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
	registerTodo,
	registerAsk,
	registerOptimizer,
	registerGate,
	registerSubagent,
	// Custom compaction: replaces pi's built-in summary + trigger (reads
	// compaction section; runs after runtime is live).
	registerCompaction,
] satisfies readonly PixExtension[];

export default function (pi: ExtensionAPI): void {
	for (const register of MEMBERS) register(pi);

	// ── Respect $SHELL for user ! commands ──────────────────────────────────
	// Pi defaults to /bin/bash for ! commands. When the user's login shell
	// differs (zsh, fish, nushell, …), redirect ! execution through $SHELL
	// in interactive mode so aliases, functions, and rc config all work.
	const userShell = process.env.SHELL;
	if (userShell && !/\bbash$/.test(userShell)) {
		const ops = createInteractiveShellOps(userShell);
		pi.on("user_bash", () => ({ operations: ops }));
	}
}

/**
 * Build BashOperations that run commands through the user's real shell with
 * rc files loaded and alias expansion enabled.
 *
 * Problem: `zsh -c "gss"` is non-interactive — it skips `.zshrc` and disables
 * alias expansion.  Even `zsh -c ". ~/.zshrc; gss"` fails because aliases
 * are resolved at parse-time, before `.zshrc` is sourced.
 *
 * Solution: source the rc file, then `eval` the command.  `eval` creates a
 * new parse boundary, so aliases defined by the source are available.
 */
function createInteractiveShellOps(
	shellPath: string,
): import("@earendil-works/pi-coding-agent").BashOperations {
	const inner = createLocalBashOperations({ shellPath });
	const name = shellPath.split("/").pop() ?? "";
	const home = process.env.HOME ?? "~";

	return {
		exec(command, cwd, options) {
			return inner.exec(wrapForShell(name, home, command), cwd, options);
		},
	};
}

/**
 * Wrap a command so it runs inside the user's shell with rc and alias support.
 */
function wrapForShell(shell: string, home: string, command: string): string {
	if (shell === "zsh") {
		// 1. source .zshrc for aliases/functions/PATH
		// 2. eval to create a fresh parse boundary so aliases expand
		return `. ${home}/.zshrc 2>/dev/null; eval ${escapeForShell(command)}`;
	}
	// Other shells: run as-is, rely on shellPath alone
	return command;
}

/** Single-quote a string for safe shell embedding. */
function escapeForShell(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}
