/**
 * agent-types.ts — Unified agent type registry.
 *
 * Merges embedded default agents with user-defined agents from .pi/agents/*.md.
 * User agents override defaults with the same name. Disabled agents are kept
 * but excluded from spawning.
 *
 * Ported from tintinweb/pi-subagents (MIT). Trimmed: dropped memory tool helpers.
 */

import { createCodingTools, createReadOnlyTools } from "@xynogen/pix-runtime/host";
import { DEFAULT_AGENTS } from "./default-agents.ts";
import type { AgentConfig } from "./types.ts";

/**
 * All known built-in tool names, derived from pi's own tool factories so the
 * set tracks pi-mono if it adds/renames a built-in. The `cwd` only binds tool
 * operations we never invoke — we read each tool's `.name` and discard it.
 */
export const BUILTIN_TOOL_NAMES: string[] = [
	...new Set([...createCodingTools("."), ...createReadOnlyTools(".")].map((t) => t.name)),
];

/** Unified runtime registry of all agents (defaults + user-defined). */
const agents = new Map<string, AgentConfig>();

/** When true, DEFAULT_AGENTS are skipped during registration. */
let disableDefaults = false;

export function isDefaultsDisabled(): boolean {
	return disableDefaults;
}

export function setDefaultsDisabled(b: boolean): void {
	disableDefaults = b;
}

/**
 * Register agents into the unified registry.
 * Starts with DEFAULT_AGENTS, then overlays user agents (overrides defaults with same name).
 * Disabled agents (enabled === false) are kept but excluded from spawning.
 */
export function registerAgents(userAgents: Map<string, AgentConfig>): void {
	agents.clear();

	if (!disableDefaults) {
		for (const [name, config] of DEFAULT_AGENTS) {
			agents.set(name, config);
		}
	}

	for (const [name, config] of userAgents) {
		agents.set(name, config);
	}
}

/** Case-insensitive key resolution. */
function resolveKey(name: string): string | undefined {
	if (agents.has(name)) return name;
	const lower = name.toLowerCase();
	for (const key of agents.keys()) {
		if (key.toLowerCase() === lower) return key;
	}
	return undefined;
}

export function resolveType(name: string): string | undefined {
	return resolveKey(name);
}

export function getAgentConfig(name: string): AgentConfig | undefined {
	const key = resolveKey(name);
	return key ? agents.get(key) : undefined;
}

/** Get all enabled type names (for spawning and tool descriptions). */
export function getAvailableTypes(): string[] {
	return [...agents.entries()]
		.filter(([, config]) => config.enabled !== false)
		.map(([name]) => name);
}

export function getAllTypes(): string[] {
	return [...agents.keys()];
}

export function isValidType(type: string): boolean {
	const key = resolveKey(type);
	if (!key) return false;
	return agents.get(key)?.enabled !== false;
}

/** Get built-in tool names for a type (case-insensitive). */
export function getToolNamesForType(type: string): string[] {
	const key = resolveKey(type);
	const raw = key ? agents.get(key) : undefined;
	const config = raw?.enabled !== false ? raw : undefined;
	// undefined → all built-ins; explicit [] → zero built-ins.
	return config?.builtinToolNames ?? [...BUILTIN_TOOL_NAMES];
}

/** Get config for a type, falling back to general. */
export function getConfig(type: string): {
	displayName: string;
	description: string;
	builtinToolNames: string[];
	extensions: true | string[] | false;
	excludeExtensions?: string[];
	skills: true | string[] | false;
	promptMode: "replace" | "append";
} {
	const key = resolveKey(type);
	const config = key ? agents.get(key) : undefined;
	if (config && config.enabled !== false) {
		return {
			displayName: config.displayName ?? config.name,
			description: config.description,
			builtinToolNames: config.builtinToolNames ?? BUILTIN_TOOL_NAMES,
			extensions: config.extensions,
			excludeExtensions: config.excludeExtensions,
			skills: config.skills,
			promptMode: config.promptMode,
		};
	}

	const gp = agents.get("general");
	if (gp && gp.enabled !== false) {
		return {
			displayName: gp.displayName ?? gp.name,
			description: gp.description,
			builtinToolNames: gp.builtinToolNames ?? BUILTIN_TOOL_NAMES,
			extensions: gp.extensions,
			excludeExtensions: gp.excludeExtensions,
			skills: gp.skills,
			promptMode: gp.promptMode,
		};
	}

	return {
		displayName: "Agent",
		description: "General-purpose agent for complex, multi-step tasks",
		builtinToolNames: BUILTIN_TOOL_NAMES,
		extensions: true,
		skills: true,
		promptMode: "append",
	};
}
