/**
 * caveman.ts — pure logic + Pi extension
 *
 * Pure helpers exported for tests; caveman(pi) is the extension entry,
 * called by index.ts alongside rtk(pi).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createMode,
	resolveLevel as resolveLevelGeneric,
	toggleLevel as toggleLevelGeneric,
} from "./mode.ts";
import type { OptimizerHandle, OptimizerStatus } from "./status.ts";

// ── Levels ────────────────────────────────────────────────────────────────────

export const LEVELS = ["off", "lite", "full", "ultra", "micro"] as const;

export type Level = (typeof LEVELS)[number];

export const STOP_ALIASES = new Set(["off", "stop", "quit", "0"]);

// Numeric shortcuts: /caveman 1|2|3
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
	micro: "MICRO",
};

// ── Prompt fragments ──────────────────────────────────────────────────────────

// ponytail: SOP owns language and style. This mode only adjusts reply length.
const BASE = `# Reply length
Keep replies concise without losing meaning, required detail, or safety checks. Explain fully when asked.
"stop caveman" or "normal mode" disables this length preference.`;

const INTENSITY: Record<Exclude<Level, "off" | "micro">, string> = {
	lite: "Remove filler. Keep useful context.",
	full: "Give the answer and needed context. Avoid repetition.",
	ultra: "Use the shortest complete answer. Add detail only when needed or requested.",
};

/**
 * Build the system prompt injection for a given level.
 * Returns empty string when level is "off".
 */
export function buildPrompt(level: Level): string {
	if (level === "off") return "";
	if (level === "micro") return BASE;
	return `${BASE}\n${INTENSITY[level]}`;
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
 * Help text shown when /caveman is run with no argument.
 */
export function buildHelp(current: Level): string {
	const statusLine = current === "off" ? "off" : `${STATUS_LABELS[current]} (${current})`;
	return [
		`Caveman mode: ${statusLine}`,
		"",
		"Usage: /caveman <level>",
		"  1  lite   - concise replies with useful context",
		"  2  full   - brief replies without repetition",
		"  3  ultra  - shortest complete replies",
		"  0  off    - disable (aliases: off, stop, quit)",
		"",
		"Other levels: micro",
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

export function caveman(pi: ExtensionAPI, status: OptimizerStatus): OptimizerHandle {
	return createMode(pi, status, {
		name: "caveman",
		help: "caveman — terse output",
		levels: LEVELS,
		buildPrompt,
		resolve: resolveLevel,
		notify: (level) => (level === "off" ? "Caveman mode off." : `Caveman: ${STATUS_LABELS[level]}`),
	});
}
