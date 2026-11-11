/**
 * ponytail.ts — pure logic + Pi extension
 *
 * "Lazy senior dev" mode: governs WHAT the agent builds (minimal code, YAGNI),
 * orthogonal to caveman which governs HOW it talks. Pure helpers exported for
 * tests; ponytail(pi, status) is the extension entry, wired by index.ts.
 *
 * Ruleset adapted from DietrichGebert/ponytail (MIT), the "lazy senior dev"
 * skill. We inject it as a system-prompt fragment — no external hooks/files.
 */

import type { ExtensionAPI } from "@xynogen/pix-runtime/host";
import {
	createMode,
	resolveLevel as resolveLevelGeneric,
	toggleLevel as toggleLevelGeneric,
} from "./mode.ts";
import type { OptimizerHandle, OptimizerStatus } from "./status.ts";

// ── Levels ────────────────────────────────────────────────────────────────────

export const LEVELS = ["off", "lite", "full", "ultra"] as const;

export type Level = (typeof LEVELS)[number];

export const STOP_ALIASES = new Set(["off", "stop", "quit", "0"]);

// Numeric shortcuts: /opt ponytail 1|2|3
export const LEVEL_NUMBERS: Record<string, Level> = {
	"1": "lite",
	"2": "full",
	"3": "ultra",
};

// ── Status labels ─────────────────────────────────────────────────────────────

export const STATUS_LABELS: Record<Exclude<Level, "off">, string> = {
	lite: "LITE",
	full: "FULL",
	ultra: "ULTRA",
};

// ── Prompt fragments ──────────────────────────────────────────────────────────

const BASE = `\
PONYTAIL MODE ACTIVE. You are a lazy senior developer. Lazy means efficient, \
not careless. The best code is the code you never write.

Before you write any code, stop at the first rung that holds:
1. Does this need to exist at all? A speculative need means you skip it. Say so in one line. (YAGNI)
2. Does the standard library do it? Use it.
3. Does a native platform feature cover it? Use it (\`<input type="date">\` over a picker library, \
CSS over JavaScript, a database constraint over application code).
4. Does an installed dependency solve it? Use it. Never add a new one for what a few lines can do.
5. Can it be one line? Write one line.
6. Only then, write the minimum code that works.

The ladder is a reflex, not a research project. If two rungs work, take the higher one and move on.

Rules:
- No unrequested abstraction. No interface with one use, no factory for one product, \
no config for a value that never changes.
- No boilerplate. No scaffolding for later. Prefer deletion to addition. Prefer boring code to clever code. \
Use the fewest files.
- Choose the simplest implementation that fulfills the user's goal in context, not the narrowest reading of the latest message. \
Make routine implementation decisions yourself; ask only when unresolved uncertainty materially affects scope, cost, or safety.
- For two stdlib options of the same size, take the one that is correct on the edge cases. \
Lazy means less code, not the weaker algorithm.
- Add a \`ponytail:\` comment only for a shortcut with a real ceiling: one line, the ceiling and the upgrade path. \
Obvious code needs no comment.`;

const INTENSITY: Record<Exclude<Level, "off">, string> = {
	lite: `\
Build what the user asks using the ladder where it helps. \
Mention a simpler alternative only when it materially helps the current task.`,

	full: `\
Enforce the ladder within the requested scope. Prefer the standard library and native features first. \
Keep the diff small without sacrificing correctness, readability, or requested behavior.`,

	ultra: `\
Apply YAGNI strictly to unrequested extras. Prefer deletion to addition where it preserves \
the requested behavior. Do not drop or challenge explicit requirements merely to reduce code.`,
};

const SAFETY = `\
When not to be lazy: never simplify away input validation at a trust boundary, \
error handling that prevents data loss, security, accessibility, or anything the user asks for. \
The hardware is never the spec ideal. Leave the calibration knob.
Lazy code without its check is unfinished. Non-trivial logic leaves ONE runnable check behind \
(an assert-based self-check or one small test file, no frameworks). A trivial one-liner needs no test.
Output: match the user's requested format and level of detail. No mandatory code-first order or line limit.
Boundaries: ponytail governs what you build, not how you talk. "stop ponytail" or "normal mode" reverts.`;

/**
 * Build the system prompt injection for a given level.
 * Returns empty string when level is "off".
 */
export function buildPrompt(level: Level): string {
	if (level === "off") return "";
	return [BASE, "", `Intensity: ${INTENSITY[level]}`, "", SAFETY].join("\n");
}

// ── Level resolution ──────────────────────────────────────────────────────────

/**
 * Resolve a raw command arg to a Level, or return null if unrecognised.
 * Handles stop aliases (stop/quit → "off") and valid level names.
 */
export function resolveLevel(arg: string): Level | null {
	return resolveLevelGeneric(arg, LEVELS, LEVEL_NUMBERS, STOP_ALIASES);
}

/**
 * Help text shown when /opt ponytail is run with no argument.
 */
export function buildHelp(current: Level): string {
	const statusLine = current === "off" ? "off" : `${STATUS_LABELS[current]} (${current})`;
	return [
		`Ponytail mode: ${statusLine}`,
		"",
		"Usage: /optimizer ponytail <level>",
		"  1  lite   - prefer simple solutions",
		"  2  full   - the ladder enforced (default)",
		"  3  ultra  - YAGNI extremist",
		"  0  off    - disable (aliases: off, stop, quit)",
		"",
		"  config    - open settings dialog",
	].join("\n");
}

/**
 * Toggle: off → full, anything else → off.
 */
export function toggleLevel(current: Level): Level {
	return toggleLevelGeneric(current);
}

// ── Pi extension ────────────────────────────────────────────────────────────

export function ponytail(pi: ExtensionAPI, status: OptimizerStatus): OptimizerHandle {
	return createMode(pi, status, {
		name: "ponytail",
		help: "ponytail — lazy senior dev (minimal code)",
		levels: LEVELS,
		buildPrompt,
		resolve: resolveLevel,
		notify: (level) =>
			level === "off" ? "Ponytail mode off." : `Ponytail: ${STATUS_LABELS[level]}`,
	});
}
