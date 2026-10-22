/**
 * custom-agents.ts — Load user-defined agents from project (.pi/agents/) and global ($PI_CODING_AGENT_DIR/agents/, default ~/.pi/agent/agents/) locations.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { agentDir, projectDir } from "@xynogen/pix-runtime/paths";
import { BUILTIN_TOOL_NAMES } from "./agent-types.ts";
import type { AgentConfig } from "./types.ts";

/**
 * Valid thinking levels. Includes "off" (ModelThinkingLevel) alongside the
 * ThinkingLevel union — the tool schema and README both document "off" as a
 * valid value, so frontmatter should accept it too.
 */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Parse and validate a thinking level value.
 * Returns the value only when it matches a known level; otherwise undefined.
 */
function thinkingLevel(val: unknown): (typeof THINKING_LEVELS)[number] | undefined {
	if (typeof val !== "string") return undefined;
	const lower = val.trim().toLowerCase();
	return (THINKING_LEVELS as readonly string[]).includes(lower)
		? (lower as (typeof THINKING_LEVELS)[number])
		: undefined;
}

/**
 * Scan for custom agent .md files from multiple locations.
 * Discovery hierarchy (higher priority wins):
 *   1. Project: <cwd>/.pi/agents/*.md
 *   2. Global:  $PI_CODING_AGENT_DIR/agents/*.md (default: ~/.pi/agent/agents/*.md)
 *
 * Project-level agents override global ones with the same name.
 * Any name is allowed — names matching defaults (e.g. "Explore") override them.
 */
export function loadCustomAgents(cwd: string): Map<string, AgentConfig> {
	const globalDir = join(agentDir(), "agents");
	const projectAgents = join(projectDir(cwd), "agents");

	const agents = new Map<string, AgentConfig>();
	loadFromDir(globalDir, agents, "global"); // lower priority
	loadFromDir(projectAgents, agents, "project"); // higher priority (overwrites)
	return agents;
}

/** Load agent configs from a directory into the map. */
function loadFromDir(
	dir: string,
	agents: Map<string, AgentConfig>,
	source: "project" | "global",
): void {
	if (!existsSync(dir)) return;

	let files: string[];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".md"));
	} catch {
		return;
	}

	for (const file of files) {
		const name = basename(file, ".md");

		let content: string;
		try {
			content = readFileSync(join(dir, file), "utf-8");
		} catch {
			continue;
		}

		const { frontmatter: fm, body } = parseFrontmatter<Record<string, unknown>>(content);

		const { builtinToolNames, extSelectors } = parseToolsField(fm.tools);

		// Validate thinking level and collect warnings for invalid values
		const warnings: string[] = [];
		const rawThinking = str(fm.thinking);
		const parsedThinking = rawThinking !== undefined ? thinkingLevel(rawThinking) : undefined;
		if (rawThinking !== undefined && parsedThinking === undefined) {
			warnings.push(
				`thinking: "${rawThinking}" is not a valid level (${THINKING_LEVELS.join("|")}) \u2014 ignored`,
			);
		}

		agents.set(name, {
			name,
			displayName: str(fm.display_name),
			description: str(fm.description) ?? name,
			builtinToolNames,
			extSelectors,
			disallowedTools: csvListOptional(fm.disallowed_tools),
			extensions: inheritField(fm.extensions ?? fm.inherit_extensions),
			excludeExtensions: csvListOptional(fm.exclude_extensions),
			skills: inheritField(fm.skills ?? fm.inherit_skills),
			model: str(fm.model),
			thinking: parsedThinking as AgentConfig["thinking"],
			warnings: warnings.length > 0 ? warnings : undefined,
			maxTurns: nonNegativeInt(fm.max_turns),
			systemPrompt: body.trim(),
			promptMode: fm.prompt_mode === "append" ? "append" : "replace",
			inheritContext: fm.inherit_context != null ? fm.inherit_context === true : undefined,

			isolated: fm.isolated != null ? fm.isolated === true : undefined,
			enabled: fm.enabled !== false, // default true; explicitly false disables
			source,
		});
	}
}

// ---- Field parsers ----
// All follow the same convention: omitted → default, "none"/empty → nothing, value → exact.

/** Extract a string or undefined. */
function str(val: unknown): string | undefined {
	return typeof val === "string" ? val : undefined;
}

/** Extract a non-negative integer or undefined. 0 means unlimited for max_turns. */
function nonNegativeInt(val: unknown): number | undefined {
	return typeof val === "number" && val >= 0 ? val : undefined;
}

/**
 * Parse a raw CSV field value into items, or undefined if absent/empty/"none".
 */
function parseCsvField(val: unknown): string[] | undefined {
	if (val === undefined || val === null) return undefined;
	const s = String(val).trim();
	if (!s || s === "none") return undefined;
	const items = s
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);
	return items.length > 0 ? items : undefined;
}

/**
 * Parse a comma-separated list field with defaults.
 * omitted → defaults; "none"/empty → []; csv → listed items.
 */
function csvList(val: unknown, defaults: string[]): string[] {
	if (val === undefined || val === null) return defaults;
	return parseCsvField(val) ?? [];
}

/**
 * Partition the `tools:` CSV into the built-in tool allowlist and raw `ext:` selectors.
 * `*` (and the case-insensitive alias `all`, for `tools: all`) expands to all
 * built-ins; plain entries are built-in names; `ext:` entries are extension-tool
 * selectors parsed later by the runner. omitted → all built-ins, no selectors.
 * `tools:` present with only `ext:` entries → zero built-ins (use `*`).
 */
function parseToolsField(val: unknown): {
	builtinToolNames: string[];
	extSelectors: string[] | undefined;
} {
	const entries = csvList(val, BUILTIN_TOOL_NAMES);
	const isWildcard = (e: string) => e === "*" || e.toLowerCase() === "all";
	const hasWildcard = entries.some(isWildcard);
	const plain = entries.filter((e) => !isWildcard(e) && !e.startsWith("ext:"));
	const extEntries = entries.filter((e) => e.startsWith("ext:"));
	return {
		builtinToolNames: hasWildcard ? [...new Set([...BUILTIN_TOOL_NAMES, ...plain])] : plain,
		extSelectors: extEntries.length > 0 ? extEntries : undefined,
	};
}

/**
 * Parse an optional comma-separated list field.
 * omitted → undefined; "none"/empty → undefined; csv → listed items.
 */
function csvListOptional(val: unknown): string[] | undefined {
	return parseCsvField(val);
}

/**
 * Parse an inherit field (extensions, skills).
 * omitted/true → true (inherit all); false/"none"/empty → false; csv → listed names.
 */
function inheritField(val: unknown): true | string[] | false {
	if (val === undefined || val === null || val === true) return true;
	if (val === false || val === "none") return false;
	const items = csvList(val, []);
	return items.length > 0 ? items : false;
}
