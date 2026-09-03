/**
 * agent-runner.ts — Core execution engine: creates sessions, runs agents, collects results.
 */

import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { Api, AssistantMessage, Model, ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionContext, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	BUILTIN_TOOL_NAMES,
	getAgentConfig,
	getConfig,
	getToolNamesForType,
} from "./agent-types.ts";
import { buildParentContext, extractText } from "./context.ts";
import { DEFAULT_AGENTS } from "./default-agents.ts";
import { detectEnv } from "./env.ts";
import { resolveModel } from "./model-resolver.ts";
import { buildAgentPrompt, type PromptExtras } from "./prompts.ts";
import type { SubagentType, ThinkingLevel } from "./types.ts";

/**
 * Tool names registered by THIS extension. Single source of truth so the
 * registration sites (index.ts) and the subagent exclusion list below can't
 * drift apart. These are our own tools, not pi built-ins, so they can't be
 * derived from pi — but they only need defining once.
 */
export const SUBAGENT_TOOL_NAMES = {
	AGENT: "agent",
	CONTROL: "agent_control",
} as const;

/** Names of tools registered by this extension that subagents must NOT inherit. */
const EXCLUDED_TOOL_NAMES = ["agent", "agent_control", "agent_info", "agent_result", "agent_steer"];

/**
 * Canonical name of an extension for `extensions: [...]` allowlist matching.
 * Lowercased — extension names match case-insensitively so `extensions: [Mcp]`
 * resolves the same as `[mcp]`. Tool names within `ext:foo/bar` are not affected.
 * Directory extensions (`foo/index.ts`) resolve to the parent directory name;
 * single-file extensions to the basename minus `.ts`/`.js`.
 */
export function extensionCanonicalName(extPath: string): string {
	const base = basename(extPath);
	const name =
		base === "index.ts" || base === "index.js"
			? basename(dirname(extPath))
			: base.replace(/\.(ts|js)$/, "");
	return name.toLowerCase();
}

/**
 * Classify `extensions: string[]` frontmatter entries for the loader-level filter.
 *
 * An entry is a PATH iff it contains a path separator or starts with `~`; otherwise
 * it is a NAME. `"*"` sets the wildcard flag (keep all default-discovered extensions).
 *
 * Path entries are resolved (`~` expanded, made absolute against `cwd`) into `paths`
 * — and their canonical name is also added to `names`. The loader override matches
 * everything by canonical name, so path-loaded extensions are matched via their name
 * rather than their post-staging `Extension.path`.
 */
export function parseExtensionsSpec(
	entries: string[],
	cwd: string,
): { names: Set<string>; paths: string[]; wildcard: boolean } {
	const names = new Set<string>();
	const paths: string[] = [];
	let wildcard = false;
	for (const entry of entries) {
		if (!entry) continue;
		if (entry === "*") {
			wildcard = true;
			continue;
		}
		const isPathEntry = entry.includes("/") || entry.includes("\\") || entry.startsWith("~");
		if (!isPathEntry) {
			names.add(entry.toLowerCase());
			continue;
		}
		let p = entry;
		if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
			p = homedir() + p.slice(1);
		}
		const abs = isAbsolute(p) ? p : resolve(cwd, p);
		paths.push(abs);
		names.add(extensionCanonicalName(abs));
	}
	return { names, paths, wildcard };
}

/**
 * Parse raw `ext:` selector strings (from the `tools:` CSV) into the set of
 * extension names to keep loaded and a per-extension tool-narrowing map.
 *
 * `ext:foo` → `extNames` has `foo`, no narrowing entry (all of foo's tools).
 * `ext:foo/bar` → `extNames` has `foo`, `narrowing.foo` has `bar` (only `bar`).
 * A name lands in `narrowing` only when a `/tool` form is seen, so a bare
 * `ext:foo` alongside `ext:foo/bar` leaves narrowing in effect (narrowing wins).
 * The split is on the first `/`; extension canonical names never contain `/`.
 */
export function parseExtSelectors(entries: string[]): {
	extNames: Set<string>;
	narrowing: Map<string, Set<string>>;
} {
	const extNames = new Set<string>();
	const narrowing = new Map<string, Set<string>>();
	for (const raw of entries) {
		if (!raw) continue;
		const body = raw.slice("ext:".length);
		const slash = body.indexOf("/");
		// Extension name matches case-insensitively (matches the loader-side canonical
		// name). Tool names are case-preserved — they're matched against pi-mono's
		// registered identifiers, which are case-sensitive.
		const name = (slash === -1 ? body : body.slice(0, slash)).trim().toLowerCase();
		if (!name) continue;
		extNames.add(name);
		if (slash === -1) continue;
		const tool = body.slice(slash + 1).trim();
		if (!tool) continue;
		let set = narrowing.get(name);
		if (!set) {
			set = new Set();
			narrowing.set(name, set);
		}
		set.add(tool);
	}
	return { extNames, narrowing };
}

/** Default max turns. undefined = unlimited (no turn limit). */
let defaultMaxTurns: number | undefined;

/** Normalize max turns. undefined or 0 = unlimited, otherwise minimum 1. */
export function normalizeMaxTurns(n: number | undefined): number | undefined {
	if (n == null || n === 0) return undefined;
	return Math.max(1, n);
}

/** Get the default max turns value. undefined = unlimited. */
export function getDefaultMaxTurns(): number | undefined {
	return defaultMaxTurns;
}
/** Set the default max turns value. undefined or 0 = unlimited, otherwise minimum 1. */
export function setDefaultMaxTurns(n: number | undefined): void {
	defaultMaxTurns = normalizeMaxTurns(n);
}

/** Additional turns allowed after the soft limit steer message. */
let graceTurns = 5;

/** Get the grace turns value. */
export function getGraceTurns(): number {
	return graceTurns;
}
/** Set the grace turns value (minimum 1). */
export function setGraceTurns(n: number): void {
	graceTurns = Math.max(1, n);
}

/** Info about a tool event in the subagent. */
export interface ToolActivity {
	type: "start" | "end";
	toolName: string;
}

export interface RunOptions {
	/** ExtensionAPI instance — used for pi.exec() instead of execSync. */
	pi: ExtensionAPI;
	/** Manager-assigned id; suffixes session name to disambiguate parallel spawns (e.g. `Explore#a1b2c3d4`). */
	agentId?: string;
	model?: Model<Api>;
	maxTurns?: number;
	signal?: AbortSignal;
	isolated?: boolean;
	inheritContext?: boolean;
	thinkingLevel?: ThinkingLevel;
	/** Override working directory (e.g. for worktree isolation). */
	cwd?: string;
	/**
	 * Where .pi config is discovered (project extensions, skills, pi settings,
	 * agent memory). Default: same as the working directory. The manager sets
	 * this to the parent session's cwd when `SpawnOptions.cwd` points the
	 * working directory elsewhere — the agent works *there* but carries the
	 * parent project's config (the target's `.pi` extensions never execute).
	 *
	 * WARNING for future callers: if you pass `cwd` pointing at a directory the
	 * user didn't open, you almost certainly must pass `configCwd` too —
	 * omitting it makes the target's `.pi` extensions execute in this process.
	 * (Worktree isolation is the one intentional exception: its copy IS the
	 * parent's repo, so config resolving inside it is correct.)
	 */
	configCwd?: string;
	/** Called on tool start/end with activity info. */
	onToolActivity?: (activity: ToolActivity) => void;
	/** Called for config warnings (unknown tool names, extension misconfig). */
	onWarning?: (message: string) => void;
	/** Called on streaming text deltas from the assistant response. */
	onTextDelta?: (delta: string, fullText: string) => void;
	onSessionCreated?: (session: AgentSession) => void;
	/** Called at the end of each agentic turn with the cumulative count. */
	onTurnEnd?: (turnCount: number) => void;
	/**
	 * Called once per assistant message_end with that message's usage delta.
	 * Lets callers maintain a lifetime accumulator that survives compaction
	 * (which replaces session.state.messages and resets stats-derived sums).
	 */
	onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
	/**
	 * Called when the session successfully compacts. `tokensBefore` is upstream's
	 * pre-compaction context size estimate. Aborted compactions don't fire.
	 */
	onCompaction?: (info: {
		reason: "manual" | "threshold" | "overflow";
		tokensBefore: number;
	}) => void;
	/**
	 * Caller-supplied tool-name subset — intersected with the resolved builtin+extension
	 * set (never widens). Omit to use the agent type's full default set.
	 */
	allowedToolNames?: string[];
}

/** Intersect resolved tools with caller allowlist. Omitting allow → resolved unchanged. */
export function narrowTools(resolved: string[], allow?: string[]): string[] {
	if (!allow) return resolved;
	const allowed = new Set(allow);
	return resolved.filter((t) => allowed.has(t));
}

export interface RunResult {
	responseText: string;
	session: AgentSession;
	/** True if the agent was hard-aborted (max_turns + grace exceeded). */
	aborted: boolean;
	/** True if the agent was steered to wrap up (hit soft turn limit) but finished in time. */
	steered: boolean;
}

/**
 * Subscribe to a session and collect the last assistant message text.
 * Returns an object with a `getText()` getter and an `unsubscribe` function.
 */
function collectResponseText(session: AgentSession) {
	let text = "";
	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "message_start") {
			text = "";
		}
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			text += event.assistantMessageEvent.delta;
		}
	});
	return { getText: () => text, unsubscribe };
}

/** Result of the turn-limit subscription returned by `attachTurnLimit`. */
export interface TurnLimitHandle {
	unsubscribe: () => void;
	/** True if the agent was hard-aborted (soft limit + grace window exceeded). */
	wasAborted: () => boolean;
	/** True if the soft-limit steer was sent (agent may still finish in time). */
	wasSteered: () => boolean;
}

/**
 * Subscribe to a session's turn/text/tool/usage/compaction events and enforce
 * a soft turn limit + grace abort window. Shared by `runAgent` (initial run)
 * and `resumeAgent` (resumed prompt).
 *
 * Turn counting starts at 0 for each attachment — when resuming, the original
 * run's count is a display stat on the record; re-applying the cap per-resume
 * is the sane semantic (the resumed prompt is a fresh task).
 */
export function attachTurnLimit(
	session: AgentSession,
	options: {
		maxTurns?: number;
		graceTurns?: number;
		onTurnEnd?: (turnCount: number) => void;
		onTextDelta?: (delta: string, fullText: string) => void;
		onToolActivity?: (activity: ToolActivity) => void;
		onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
		onCompaction?: (info: {
			reason: "manual" | "threshold" | "overflow";
			tokensBefore: number;
		}) => void;
	},
): TurnLimitHandle {
	let turnCount = 0;
	let softLimitReached = false;
	let aborted = false;
	let currentMessageText = "";
	const effectiveGrace = options.graceTurns ?? graceTurns;

	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "turn_end") {
			turnCount++;
			options.onTurnEnd?.(turnCount);
			if (options.maxTurns != null) {
				if (!softLimitReached && turnCount >= options.maxTurns) {
					softLimitReached = true;
					session.steer(
						"You have reached your turn limit. Wrap up immediately \u2014 provide your final answer now.",
					);
				} else if (softLimitReached && turnCount >= options.maxTurns + effectiveGrace) {
					aborted = true;
					session.abort();
				}
			}
		}
		if (event.type === "message_start") {
			currentMessageText = "";
		}
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			currentMessageText += event.assistantMessageEvent.delta;
			options.onTextDelta?.(event.assistantMessageEvent.delta, currentMessageText);
		}
		if (event.type === "tool_execution_start") {
			options.onToolActivity?.({ type: "start", toolName: event.toolName });
		}
		if (event.type === "tool_execution_end") {
			options.onToolActivity?.({ type: "end", toolName: event.toolName });
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			const u = (event.message as AssistantMessage).usage;
			if (u)
				options.onAssistantUsage?.({
					input: u.input ?? 0,
					output: u.output ?? 0,
					cacheWrite: u.cacheWrite ?? 0,
				});
		}
		if (event.type === "compaction_end" && !event.aborted && event.result) {
			options.onCompaction?.({
				reason: event.reason,
				tokensBefore: event.result.tokensBefore,
			});
		}
	});

	return {
		unsubscribe,
		wasAborted: () => aborted,
		wasSteered: () => softLimitReached,
	};
}

/** Get the last assistant text from the completed session history. */
function getLastAssistantText(session: AgentSession): string {
	for (let i = session.messages.length - 1; i >= 0; i--) {
		const msg = session.messages[i];
		// biome-ignore lint/complexity/useOptionalChain: msg may be undefined; optional chain would not skip undefined entries
		if (!msg || msg.role !== "assistant") continue;
		const text = extractText(
			(msg as { content: Parameters<typeof extractText>[0] }).content,
		).trim();
		if (text) return text;
	}
	return "";
}

/**
 * Wire an AbortSignal to abort a session.
 * Returns a cleanup function to remove the listener.
 */
function forwardAbortSignal(session: AgentSession, signal?: AbortSignal): () => void {
	if (!signal) return () => {};
	const onAbort = () => session.abort();
	signal.addEventListener("abort", onAbort, { once: true });
	return () => signal.removeEventListener("abort", onAbort);
}

export async function runAgent(
	ctx: ExtensionContext,
	type: SubagentType,
	prompt: string,
	options: RunOptions,
): Promise<RunResult> {
	const config = getConfig(type);
	const agentConfig = getAgentConfig(type);

	// Resolve working directory: worktree override > parent cwd
	const effectiveCwd = options.cwd ?? ctx.cwd;
	// Filesystem work happens in effectiveCwd; config discovery in configCwd.
	// They differ only for SpawnOptions.cwd spawns (config stays with the parent).
	const configCwd = options.configCwd ?? effectiveCwd;

	const env = await detectEnv(options.pi, effectiveCwd);

	// Get parent system prompt for append-mode agents
	const parentSystemPrompt = ctx.getSystemPrompt();

	// Build prompt extras (memory, skill preloading)
	const extras: PromptExtras = {};

	// Resolve extensions/skills: isolated overrides to false
	const extensions = options.isolated ? false : config.extensions;
	// Nulling excludes under isolated also suppresses the orphaned-exclude warning —
	// isolation is an intentional override, not a misconfiguration.
	const excludeExtensions = options.isolated ? undefined : config.excludeExtensions;
	const skills = options.isolated ? false : config.skills;

	// ponytail: skill-preload + persistent memory deferred to v2
	let toolNames = getToolNamesForType(type);

	// allowed_tools[] narrowing: caller-supplied subset is intersected (never widens)
	if (options.allowedToolNames) {
		toolNames = narrowTools(toolNames, options.allowedToolNames);
	}

	// Build system prompt from agent config
	let systemPrompt: string;
	if (agentConfig) {
		systemPrompt = buildAgentPrompt(agentConfig, effectiveCwd, env, parentSystemPrompt, extras);
	} else {
		// Unknown type fallback: spread the canonical general config (defensive —
		// unreachable in practice since index.ts resolves unknown types before calling runAgent).
		const fallback = DEFAULT_AGENTS.get("general");
		if (!fallback) throw new Error(`No fallback config available for unknown type "${type}"`);
		systemPrompt = buildAgentPrompt(
			{ ...fallback, name: type },
			effectiveCwd,
			env,
			parentSystemPrompt,
			extras,
		);
	}

	// When skills is string[], we've already preloaded them into the prompt.
	// Still pass noSkills: true since we don't need the skill loader to load them again.
	const noSkills = skills === false || Array.isArray(skills);

	const agentDir = getAgentDir();

	// Extension loading:
	// - true  → all default-discovered extensions
	// - false → none (noExtensions)
	// - string[] → loader-level allowlist. Bare names keep the matching
	//   default-discovered extension; path entries load that extension fresh;
	//   "*" keeps all default-discovered extensions. Excluded extensions never
	//   bind handlers or register tools (their factory still runs once).
	//
	// Suppress AGENTS.md/CLAUDE.md and APPEND_SYSTEM.md — upstream's
	// buildSystemPrompt() re-appends both AFTER systemPromptOverride, which
	// would defeat prompt_mode: replace and isolated: true. Parent context, if
	// wanted, reaches the subagent via prompt_mode: append (parentSystemPrompt
	// is embedded in systemPromptOverride) or inherit_context (conversation).
	// `ext:` selectors from the `tools:` CSV narrow which extension tools surface to
	// the LLM. They do NOT control loading — `extensions:` is the sole authority for
	// which extensions load. `ext:foo` against an extension that `extensions:` excluded
	// is an orphan and warns after reload. `isolated` means no extension tools at all.
	const { extNames, narrowing } = parseExtSelectors(
		options.isolated ? [] : (agentConfig?.extSelectors ?? []),
	);
	const noExtensions = extensions === false;

	const extensionsSpec = Array.isArray(extensions)
		? parseExtensionsSpec(extensions, configCwd)
		: undefined;
	const keepNames = extensionsSpec?.names ?? new Set<string>();
	// `exclude_extensions:` is a denylist applied AFTER the include set — exclude wins.
	// Plain canonical names only (case-insensitive). Note: excluded extensions'
	// factories still run once during reload() (see comment above) — exclusion
	// suppresses handler binding and tool registration; it is not a sandbox.
	const excludeNames = new Set((excludeExtensions ?? []).map((n) => n.toLowerCase()));
	const hasExcludes = excludeNames.size > 0;
	// The override filters loaded extensions down to `keepNames` minus `excludeNames`.
	// It's only needed when we're neither loading everything without excludes
	// (`extensions: true` or a `"*"` wildcard) nor nothing (`noExtensions`).
	const loadAll = extensions === true || extensionsSpec?.wildcard === true;
	const additionalExtensionPaths = extensionsSpec?.paths.length ? extensionsSpec.paths : undefined;
	// Pre-filter discovered set, captured by the override — the exclude-typo warning
	// must compare against this, not the surviving set (absence from survivors is
	// an exclude *succeeding*).
	let discoveredNames: Set<string> | undefined;
	const extensionsOverride: ((base: LoadExtensionsResult) => LoadExtensionsResult) | undefined =
		noExtensions || (loadAll && !hasExcludes)
			? undefined
			: (base) => {
					discoveredNames = new Set(base.extensions.map((e) => extensionCanonicalName(e.path)));
					return {
						...base,
						extensions: base.extensions.filter((e) => {
							const name = extensionCanonicalName(e.path);
							if (excludeNames.has(name)) return false; // exclude wins
							return loadAll || keepNames.has(name);
						}),
					};
				};

	const loader = new DefaultResourceLoader({
		cwd: configCwd,
		agentDir,
		noExtensions,
		additionalExtensionPaths,
		extensionsOverride,
		noSkills,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPromptOverride: () => systemPrompt,
		appendSystemPromptOverride: () => [],
	});
	await loader.reload();

	// Plain entries in `tools:` are expected to be built-in names (extension tools
	// go through `ext:`), so an unknown name there is unambiguously a typo. Previously
	// this produced a silently broken agent (#75) — pi-mono accepted the bogus name
	// into the allowlist, then dropped it at registration with no signal back.
	if (agentConfig?.builtinToolNames?.length) {
		const knownBuiltins = new Set(BUILTIN_TOOL_NAMES);
		for (const name of agentConfig.builtinToolNames) {
			if (!knownBuiltins.has(name)) {
				options.onWarning?.(`tool "${name}" requested by agent "${type}" is not a known built-in`);
			}
		}
	}

	// A subagent spawns mid-task, so a bad `extensions:`/`ext:` entry warns rather
	// than aborts. Two distinct misconfigurations to catch:
	//   - `extensions: [foo]` but no extension named foo was discovered (typo or
	//     path that failed to load — path entries fold their canonical name into
	//     `keepNames`, so this covers them too).
	//   - `tools: ext:foo` but foo isn't in the loaded set (because `extensions:`
	//     didn't include it). Since v0.9, `ext:` no longer pulls extensions in;
	//     loading is `extensions:`-authoritative.
	// An exclude_extensions: alongside extensions: false is contradictory — nothing
	// loads, so there is nothing to exclude.
	if (hasExcludes && noExtensions) {
		options.onWarning?.(
			`exclude_extensions has no effect for agent "${type}" — extensions: false loads nothing`,
		);
	}
	// Exclude typo check: compares against the PRE-filter discovered set (an excluded
	// name absent from the surviving set is the exclude working as intended). Also
	// flags path-like and "*" entries — excludes are plain names only.
	if (hasExcludes && discoveredNames) {
		for (const name of excludeNames) {
			if (!discoveredNames.has(name)) {
				options.onWarning?.(
					`exclude_extensions: "${name}" for agent "${type}" did not match any discovered extension`,
				);
			}
		}
	}
	if (keepNames.size > 0 || extNames.size > 0) {
		const survivingNames = new Set(
			loader.getExtensions().extensions.map((e) => extensionCanonicalName(e.path)),
		);
		for (const name of keepNames) {
			if (!survivingNames.has(name)) {
				options.onWarning?.(
					excludeNames.has(name)
						? `extension "${name}" is in both extensions: and exclude_extensions: for agent "${type}" — exclude wins`
						: `extension "${name}" requested by agent "${type}" was not loaded`,
				);
			}
		}
		for (const name of extNames) {
			if (!survivingNames.has(name)) {
				options.onWarning?.(
					`ext:${name} referenced by agent "${type}" but extension "${name}" is not loaded (check extensions:/exclude_extensions:)`,
				);
			}
		}
	}

	// Resolve model: explicit option > config.model > parent model.
	// Uses the shared resolveModel() (fuzzy + exact) so config.model strings
	// like "haiku" resolve the same way as tool-path model params.
	let model = options.model;
	if (!model && agentConfig?.model) {
		const resolved = resolveModel(agentConfig.model, ctx.modelRegistry);
		if (typeof resolved === "string") {
			// Unresolvable config model — fall back to parent silently, warn caller.
			options.onWarning?.(
				`agent "${type}" config.model "${agentConfig.model}" could not be resolved — using parent model`,
			);
			model = ctx.model;
		} else {
			model = resolved;
		}
	}
	if (!model) model = ctx.model;

	// Resolve thinking level: explicit option > agent config > subagent default.
	// Keep this fallback here as well as invocation-config so programmatic callers
	// that bypass the public agent tool receive the same default.
	const thinkingLevel = options.thinkingLevel ?? agentConfig?.thinking ?? "medium";

	const disallowedSet = agentConfig?.disallowedTools
		? new Set(agentConfig.disallowedTools)
		: undefined;

	// Enumerate extension-registered tool names from the loaded resource loader.
	// Extensions populate `extension.tools` during `loader.reload()` and the set
	// is stable afterwards — `bindExtensions` does not register new tools.
	//
	// Opt-in flip: when any `ext:` selector is present, extension tools become an
	// explicit allowlist — a loaded extension not named by a selector contributes
	// no tools (its handlers still ran), and `ext:foo/bar` narrows `foo` to `bar`.
	const extensionToolNames: string[] = [];
	if (!noExtensions) {
		const optInActive = extNames.size > 0;
		for (const extension of loader.getExtensions().extensions) {
			const canon = extensionCanonicalName(extension.path);
			if (optInActive && !extNames.has(canon)) continue;
			const narrowed = narrowing.get(canon);
			for (const toolName of extension.tools.keys()) {
				if (narrowed && !narrowed.has(toolName)) continue;
				extensionToolNames.push(toolName);
			}
		}
	}

	// Build the master tool allowlist applied at session construction.
	// pi-mono's `allowedToolNames` gates BOTH registration and the initial active
	// set, so listing the exact final set here means the session is correctly
	// scoped from the first instant — no post-construction narrowing required.
	const builtinToolNameSet = new Set(toolNames);
	const allowedToolNamesSet = options.allowedToolNames
		? new Set(options.allowedToolNames)
		: undefined;
	const allowedTools = [...toolNames, ...extensionToolNames].filter((t) => {
		if (EXCLUDED_TOOL_NAMES.includes(t)) return false;
		if (disallowedSet?.has(t)) return false;
		// allowed_tools[] intersection: extension tools are also subject to the caller allowlist
		if (allowedToolNamesSet && !allowedToolNamesSet.has(t)) return false;
		if (builtinToolNameSet.has(t)) return true;
		return !noExtensions;
	});

	const sessionOpts: NonNullable<Parameters<typeof createAgentSession>[0]> = {
		cwd: effectiveCwd,
		agentDir,
		sessionManager: SessionManager.inMemory(effectiveCwd),
		settingsManager: SettingsManager.create(configCwd, agentDir),
		model,
		tools: allowedTools,
		resourceLoader: loader,
	};
	if (thinkingLevel) {
		sessionOpts.thinkingLevel = thinkingLevel;
	}

	const { session } = await createAgentSession(sessionOpts);

	const baseSessionName = agentConfig?.name ?? type;
	session.setSessionName(
		options.agentId ? `${baseSessionName}#${options.agentId.slice(0, 8)}` : baseSessionName,
	);

	// Bind extensions so that session_start fires and extensions can initialize
	// (e.g. loading credentials, setting up state). Tool gating already happened
	// at session construction via the `tools:` allowlist above — no separate
	// post-bind filter is needed. All ExtensionBindings fields are optional.
	await session.bindExtensions({
		onError: (err) => {
			options.onWarning?.(`extension error: ${err.extensionPath}`);
		},
	});

	options.onSessionCreated?.(session);

	// Track turns for graceful max_turns enforcement via the shared helper.
	const maxTurns = normalizeMaxTurns(options.maxTurns ?? agentConfig?.maxTurns ?? defaultMaxTurns);
	const turnLimit = attachTurnLimit(session, {
		maxTurns,
		onTurnEnd: options.onTurnEnd,
		onTextDelta: options.onTextDelta,
		onToolActivity: options.onToolActivity,
		onAssistantUsage: options.onAssistantUsage,
		onCompaction: options.onCompaction,
	});

	const collector = collectResponseText(session);
	const cleanupAbort = forwardAbortSignal(session, options.signal);

	// Build the effective prompt: optionally prepend parent context
	let effectivePrompt = prompt;
	if (options.inheritContext) {
		const parentContext = buildParentContext(ctx);
		if (parentContext) {
			effectivePrompt = parentContext + prompt;
		}
	}

	try {
		await session.prompt(effectivePrompt);
	} finally {
		turnLimit.unsubscribe();
		collector.unsubscribe();
		cleanupAbort();
	}

	const responseText = collector.getText().trim() || getLastAssistantText(session);
	return {
		responseText,
		session,
		aborted: turnLimit.wasAborted(),
		steered: turnLimit.wasSteered(),
	};
}

/** Result shape for `resumeAgent` — mirrors the essential fields of `RunResult`. */
export interface ResumeResult {
	responseText: string;
	/** True if the agent was hard-aborted (max_turns + grace exceeded). */
	aborted: boolean;
	/** True if the agent was steered to wrap up (hit soft turn limit) but finished in time. */
	steered: boolean;
}

/**
 * Send a new prompt to an existing session (resume).
 *
 * Turn counting starts fresh at 0 for each resume — the original run's count
 * is a display stat on the record; re-applying the cap per-resume is the sane
 * semantic (the resumed prompt is a fresh task).
 */
export async function resumeAgent(
	session: AgentSession,
	prompt: string,
	options: {
		maxTurns?: number;
		onTurnEnd?: (turnCount: number) => void;
		onTextDelta?: (delta: string, fullText: string) => void;
		onToolActivity?: (activity: ToolActivity) => void;
		onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
		onCompaction?: (info: {
			reason: "manual" | "threshold" | "overflow";
			tokensBefore: number;
		}) => void;
		signal?: AbortSignal;
	} = {},
): Promise<ResumeResult> {
	const collector = collectResponseText(session);
	const cleanupAbort = forwardAbortSignal(session, options.signal);

	// Reuse the shared turn-limit helper — same soft steer + grace abort as runAgent.
	const turnLimit = attachTurnLimit(session, {
		maxTurns: normalizeMaxTurns(options.maxTurns),
		onTurnEnd: options.onTurnEnd,
		onTextDelta: options.onTextDelta,
		onToolActivity: options.onToolActivity,
		onAssistantUsage: options.onAssistantUsage,
		onCompaction: options.onCompaction,
	});

	try {
		await session.prompt(prompt);
	} finally {
		turnLimit.unsubscribe();
		collector.unsubscribe();
		cleanupAbort();
	}

	const responseText = collector.getText().trim() || getLastAssistantText(session);
	return {
		responseText,
		aborted: turnLimit.wasAborted(),
		steered: turnLimit.wasSteered(),
	};
}

/**
 * Send a steering message to a running subagent.
 * The message will interrupt the agent after its current tool execution.
 */
export async function steerAgent(session: AgentSession, message: string): Promise<void> {
	await session.steer(message);
}

/**
 * Get the subagent's conversation messages as formatted text.
 *
 * A character cap (`maxChars`, default 30 000) prevents verbose output from
 * flooding the parent's context window. The cap is tail-anchored: the MOST
 * RECENT parts are kept, oldest are dropped, and a marker line indicates how
 * many entries were omitted (same pattern as `buildParentContext`).
 */
/** Render messages into labelled transcript parts ("[User]: …", "[Assistant]: …", …). */
function formatMessageParts(messages: AgentSession["messages"]): string[] {
	const parts: string[] = [];

	for (const msg of messages) {
		if (msg.role === "user") {
			const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
			if (text.trim()) parts.push(`[User]: ${text.trim()}`);
		} else if (msg.role === "assistant") {
			const textParts: string[] = [];
			const toolCalls: string[] = [];
			for (const c of msg.content) {
				if (c.type === "text" && c.text) textParts.push(c.text);
				else if (c.type === "toolCall")
					toolCalls.push(`  Tool: ${(c as ToolCall).name ?? "unknown"}`);
			}
			if (textParts.length > 0) parts.push(`[Assistant]: ${textParts.join("\n")}`);
			if (toolCalls.length > 0) parts.push(`[Tool Calls]:\n${toolCalls.join("\n")}`);
		} else if (msg.role === "toolResult") {
			const text = extractText(msg.content);
			const truncated = text.length > 200 ? `${text.slice(0, 200)}...` : text;
			parts.push(`[Tool Result (${msg.toolName})]: ${truncated}`);
		}
	}

	return parts;
}

/** Tail-anchored char budget: keep the most recent parts, drop the oldest. */
function applyTailBudget(parts: string[], maxChars: number): string {
	if (parts.length === 0) return "";

	let budget = maxChars;
	let firstKept = parts.length;
	for (let i = parts.length - 1; i >= 0; i--) {
		const part = parts[i];
		if (!part) break;
		const cost = part.length + (i < parts.length - 1 ? 2 : 0);
		if (budget - cost < 0) break;
		budget -= cost;
		firstKept = i;
	}

	const omitted = firstKept;
	const kept = parts.slice(firstKept);
	const marker =
		omitted > 0
			? `[\u2026truncated: ${omitted} earlier ${omitted === 1 ? "entry" : "entries"} omitted]\n\n`
			: "";

	return marker + kept.join("\n\n");
}

export function getAgentConversation(session: AgentSession, maxChars = 30_000): string {
	return applyTailBudget(formatMessageParts(session.messages), maxChars);
}

/**
 * Transcript of the last N turns of a session — one "turn" = an assistant
 * message plus its tool calls/results (mirrors the `turn_end` counting in
 * attachTurnLimit). A leading user-only group (the initial prompt) does not
 * count as a turn. Works on terminated sessions too: session.messages is
 * retained on the record until cleanup, so stopped/aborted/errored agents
 * still have their partial history.
 */
export function getAgentLastTurns(session: AgentSession, turns: number, maxChars = 30_000): string {
	const groups: AgentSession["messages"][] = [];
	let current: AgentSession["messages"] = [];
	for (const msg of session.messages) {
		if (msg.role === "assistant" && current.length > 0) {
			groups.push(current);
			current = [];
		}
		current.push(msg);
	}
	if (current.length > 0) groups.push(current);

	const turnGroups = groups.filter((g) => g.some((m) => m.role === "assistant"));
	const kept = turnGroups.slice(-Math.max(1, Math.floor(turns)));
	return applyTailBudget(formatMessageParts(kept.flat()), maxChars);
}
