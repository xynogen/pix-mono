/**
 * types.ts — Type definitions for the pix-subagent system.
 *
 * Ported from tintinweb/pi-subagents (MIT) with trimmed deferred fields:
 * memory, isolation, worktree, joinMode, scheduling.
 */

import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { LifetimeUsage } from "./usage.ts";

export type { LifetimeUsage, ThinkingLevel };

/** Agent type: any string name (built-in defaults or user-defined). */
export type SubagentType = string;

/** Names of the four embedded default agents. */
export const DEFAULT_AGENT_NAMES = ["general", "Explore", "Plan", "Mentor"] as const;

/** Unified agent configuration — used for both default and user-defined agents. */
export interface AgentConfig {
	name: string;
	/** Populated at load time for invalid frontmatter values (e.g. unknown thinking level). */
	warnings?: string[];
	displayName?: string;
	description: string;
	builtinToolNames?: string[];
	/** Raw `ext:` selector entries from the `tools:` CSV, e.g. ["ext:foo", "ext:bar/x"]. */
	extSelectors?: string[];
	/** Tool denylist — removed even if builtinToolNames or extensions include them. */
	disallowedTools?: string[];
	/** true = inherit all, string[] = only listed, false = none */
	extensions: true | string[] | false;
	/** Extension-name denylist applied after the extensions include set. Exclude wins. */
	excludeExtensions?: string[];
	/** true = inherit all, string[] = only listed, false = none */
	skills: true | string[] | false;
	model?: string;
	thinking?: ThinkingLevel;
	maxTurns?: number;
	systemPrompt: string;
	promptMode: "replace" | "append";
	/** Default for spawn: fork parent conversation. undefined = caller decides. */
	inheritContext?: boolean;

	/** Default for spawn: no extension tools. undefined = caller decides. */
	isolated?: boolean;
	/** true = this is an embedded default agent (informational) */
	isDefault?: boolean;
	/** false = agent is hidden from the registry */
	enabled?: boolean;
	/** Where this agent was loaded from */
	source?: "default" | "project" | "global";
}

export interface AgentRecord {
	id: string;
	type: SubagentType;
	description: string;
	status: "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error";
	result?: string;
	error?: string;
	toolUses: number;
	startedAt: number;
	completedAt?: number;
	session?: AgentSession;
	abortController?: AbortController;
	promise?: Promise<string>;
	/** Set when result was already consumed via agent_control — suppresses completion notification. */
	resultConsumed?: boolean;
	/** Steering messages queued before the session was ready. */
	pendingSteers?: string[];
	/** The tool_use_id from the original agent tool call. */
	toolCallId?: string;
	/**
	 * Lifetime usage breakdown, accumulated via message_end events.
	 * Survives compaction. Total = input + output + cacheWrite.
	 */
	lifetimeUsage: LifetimeUsage;
	/** Number of times this agent's session has compacted. */
	compactionCount: number;
	/** Cumulative agentic turns. Persisted on the record so the finished widget
	 * line stays full after agentActivity is cleared on completion. */
	turnCount: number;
	/** Turn cap, if any — for the ↻N≤M display. */
	maxTurns?: number;
	/** Cumulative milliseconds spent streaming output (for accurate t/s). */
	streamingMs: number;
	/** Resolved spawn params, captured for UI display. */
	invocation?: AgentInvocation;
	/** True when this agent was launched in background mode. */
	isBackground?: boolean;
}

export interface AgentInvocation {
	/** Short model label — ALWAYS set (the pix twist: shown in widget even when same as parent). */
	modelName?: string;
	thinking?: ThinkingLevel;
	maxTurns?: number;
	isolated?: boolean;
	inheritContext?: boolean;
}

export type TerminalAgentStatus = "completed" | "steered" | "aborted" | "stopped" | "error";

/** Details attached to terminal custom notification messages for visual rendering. */
export interface AgentInfoResultDetails {
	_type: "agent-info";
	kind: "types" | "models" | "active";
	query?: string;
	count: number;
}

export interface AgentResultDetails {
	_type: "agent-result";
	agentId: string;
	status: AgentRecord["status"] | "not-found";
	verbose: boolean;
	/** Set when the caller requested the last N turns instead of the full/default output. */
	turns?: number;
	hasOutput: boolean;
}

export interface AgentSteerResultDetails {
	_type: "agent-steer";
	agentId: string;
	action: "steer" | "stop";
	outcome:
		| "delivered"
		| "queued"
		| "stopped"
		| "already-finished"
		| "not-found"
		| "invalid"
		| "error";
}

export type AgentUtilityResultDetails =
	| AgentInfoResultDetails
	| AgentResultDetails
	| AgentSteerResultDetails;

export interface NotificationDetails {
	id: string;
	description: string;
	status: TerminalAgentStatus;
	/** Short model label — shown in notification stats (the pix twist). */
	modelName?: string;
	toolUses: number;
	turnCount: number;
	maxTurns?: number;
	/** Context usage snapshot, or null when unavailable. */
	contextUsage: {
		tokens: number | null;
		contextWindow: number | null;
		percent: number | null;
	} | null;
	/** Raw output tokens (for t/s). */
	outputTokens?: number;
	/** Cumulative streaming-only milliseconds (for accurate t/s). */
	streamingMs?: number;
	durationMs: number;
	error?: string;
	/** Bounded output retained for the expanded notification. */
	resultPreview: string;
	resultTruncated?: boolean;
}

export interface EnvInfo {
	isGitRepo: boolean;
	branch: string;
	platform: string;
}
