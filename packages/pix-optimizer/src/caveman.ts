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

const BASE = `\
IMPORTANT: You write in ASD-STE100 Simplified Technical English. Two layers stay on. \
Both layers govern prose only. They do not touch code, identifiers, or command syntax.

LAYER 1 — words and sentences:
- Use one name for one thing. Do not rotate check / verify / validate for the same action.
- Use the short common word: start (not initiate), use (not utilize), help (not facilitate), \
make sure (not ensure), do (not perform), give (not provide), before (not prior to), \
about (not regarding), get (not obtain), show (not demonstrate), also (not moreover).
- No marketing adjectives: seamless, robust, powerful, cutting-edge, effortless.
- Use the active voice. Write "the parser reads the file", not "the file is read by the parser".
- Use simple tenses only. Write "we received the report", not "we have received the report".
- Use a verb for an action. Write "analyze the log", not "perform an analysis of the log".
- No phrasal verbs: spin up, dive into, kick off, roll out.
- One instruction per sentence. Max 20 words for an instruction, max 25 words for other text.
- Keep the article (a, an, the). Do not drop words to compress.
- No semicolons. Write two sentences.

LAYER 2 — reply shape:
- Lead with the next action. The first line is a command, a path, or a snippet the reader can do now.
- Number a multi-step task. One bounded action per step.
- No preamble, no recap, no closer. Start with the answer. Stop when the answer is done.
- Cap an action list at five items. Split into "do now" and "later" past five.
- Give an estimate in concrete units (minutes, hours, days). Do not write "some work".
- Restate the state of multi-turn work. Write "step 3 of 5 done".
- Stay matter-of-fact about an error. Give the cause and the fix.

Bad: "Sure! I'd be happy to help. The issue you are experiencing is likely caused by..."
Good: "Bug in the auth middleware. The token expiry check uses \`<\`, not \`<=\`. Fix:"`;

const MICRO_PROMPT = `# STE output
Write in Simplified Technical English. Use short common words, the active voice, and simple tenses.
- One instruction per sentence, max 20 words. Keep the article (a, an, the).
- No phrasal verbs, no semicolons, no marketing adjectives.
- Reply shape: lead with the next action (a command, a path, or a snippet). No preamble, no closer.
- Number a multi-step task. Give an estimate in concrete units.
- Preserve code, identifiers, and error strings exactly.`;

const INTENSITY: Record<Exclude<Level, "off" | "micro">, string> = {
	lite: `\
STE-flavored words. Keep the sentence, tense, active-voice, and no-phrasal-verb discipline. \
Relax the strict dictionary. Apply the reply shape lightly: lead with the answer, no preamble or closer.
Example: "The component re-renders because you create a new object reference each render. Wrap it in \`useMemo\`."`,

	full: `\
STE-flavored words with the full Layer 2 shape. Number the steps. Cap the action list at five items. \
Restate the multi-turn state.
Example: "Wrap the prop in \`useMemo\`. Cause: a new object reference each render forces a re-render."`,

	ultra: `\
Strict STE. Apply the strict word set (but not however, because not since, can not may, \
must not should) and both length caps. Keep the full Layer 2 shape.
Example: "Wrap the prop in \`useMemo\`. A new object reference each render forces a re-render."`,
};

const SAFETY = `\
When to break Layer 2: if the user asks you to explain, explain in full, but keep the \
no-preamble and no-closer rules. Before a destructive action, confirm first — safety beats brevity. \
In a debug spiral, name the wrong assumption and ask one question. On real ambiguity, ask one short question.
Guards: never drop a fact, a number, a condition, or a scope qualifier to satisfy a length cap. \
Preserve code, identifiers, units, and error strings exactly.
Boundaries: this governs prose, not code. "stop caveman" or "normal mode" reverts.`;

/**
 * Build the system prompt injection for a given level.
 * Returns empty string when level is "off".
 */
export function buildPrompt(level: Level): string {
	if (level === "off") return "";
	if (level === "micro") return MICRO_PROMPT;
	// ponytail: lite relaxes most of BASE, so it ships the short MICRO rules + its intensity (~800 tokens less).
	if (level === "lite")
		return [MICRO_PROMPT, "", `Intensity: ${INTENSITY.lite}`, "", SAFETY].join("\n");
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
 * Help text shown when /caveman is run with no argument.
 */
export function buildHelp(current: Level): string {
	const statusLine = current === "off" ? "off" : `${STATUS_LABELS[current]} (${current})`;
	return [
		`Caveman mode: ${statusLine}`,
		"",
		"Usage: /caveman <level>",
		"  1  lite   - STE-flavored words, light reply shape",
		"  2  full   - STE words + full ADHD reply shape",
		"  3  ultra  - strict STE + full reply shape",
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
