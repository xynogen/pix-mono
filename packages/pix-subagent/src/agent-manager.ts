/**
 * agent-manager.ts — Tracks agents, background execution, resume support.
 *
 * All agents run in background and are subject to a configurable concurrency
 * limit (default: 4). Excess agents are queued and auto-started as running
 * agents complete.
 */

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	resumeAgent as _resumeAgentReal,
	runAgent as _runAgentReal,
	type ToolActivity,
} from "./agent-runner.ts";

// ── Test-only injection point ────────────────────────────────────────────────
// Allows tests to replace runAgent/resumeAgent with controllable fakes without
// requiring flaky module-level mocking. Production code never calls the setter.
let _runAgentImpl: typeof _runAgentReal = _runAgentReal;
let _resumeAgentImpl: typeof _resumeAgentReal = _resumeAgentReal;

/** @internal Test-only: replace the runAgent implementation. */
export function __setRunAgentForTests(fn: typeof _runAgentReal): void {
	_runAgentImpl = fn;
}
/** @internal Test-only: replace the resumeAgent implementation. */
export function __setResumeAgentForTests(fn: typeof _resumeAgentReal): void {
	_resumeAgentImpl = fn;
}
/** @internal Test-only: restore the real implementations. */
export function __resetAgentRunnersForTests(): void {
	_runAgentImpl = _runAgentReal;
	_resumeAgentImpl = _resumeAgentReal;
}

import { beginAgentActivity } from "@xynogen/pix-runtime";
import type { AgentInvocation, AgentRecord, SubagentType, ThinkingLevel } from "./types.ts";
import { addUsage } from "./usage.ts";

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;
export type OnAgentCompact = (record: AgentRecord, info: CompactionInfo) => void;
export type CompactionInfo = {
	reason: "manual" | "threshold" | "overflow";
	tokensBefore: number;
};

/** Default max concurrent background agents. */
const DEFAULT_MAX_CONCURRENT = 4;

/**
 * Validate a caller-supplied SpawnOptions.cwd. `undefined`/`null` mean "unset"
 * (parent cwd). Anything else must be an absolute path to an existing
 * directory — curated errors instead of TypeErrors from path/fs internals
 * (RPC callers send arbitrary JSON: null, numbers, file paths).
 */
function assertValidSpawnCwd(cwd: unknown): asserts cwd is string | undefined | null {
	if (cwd == null) return;
	if (typeof cwd !== "string" || !isAbsolute(cwd)) {
		throw new Error(`SpawnOptions.cwd must be an absolute path: "${String(cwd)}"`);
	}
	let isDirectory = false;
	try {
		isDirectory = statSync(cwd).isDirectory();
	} catch {
		throw new Error(`SpawnOptions.cwd does not exist: "${cwd}"`);
	}
	if (!isDirectory) {
		throw new Error(`SpawnOptions.cwd is not a directory: "${cwd}"`);
	}
}

interface SpawnArgs {
	pi: ExtensionAPI;
	endActivity?: () => void;
	ctx: ExtensionContext;
	type: SubagentType;
	prompt: string;
	options: SpawnOptions;
}

interface SpawnOptions {
	description: string;
	model?: Model<Api>;
	maxTurns?: number;
	isolated?: boolean;
	inheritContext?: boolean;
	thinkingLevel?: ThinkingLevel;
	isBackground?: boolean;
	/**
	 * Skip the maxConcurrent queue check for this spawn — start immediately even
	 * if the configured concurrency limit would otherwise queue it. Used by the
	 * scheduler so a fired job can't be deferred past its trigger window.
	 */
	bypassQueue?: boolean;
	/** Working directory for the agent (absolute path). Default: parent session cwd. */
	cwd?: string;
	/** Resolved invocation snapshot captured for UI display. */
	invocation?: AgentInvocation;
	/** Parent abort signal — when aborted, the subagent is also stopped. */
	signal?: AbortSignal;
	/** Called on tool start/end with activity info (for streaming progress to UI). */
	onToolActivity?: (activity: ToolActivity) => void;
	/** Called on streaming text deltas from the assistant response. */
	onTextDelta?: (delta: string, fullText: string) => void;
	/** Called when the agent session is created (for accessing session stats). */
	onSessionCreated?: (session: AgentSession) => void;
	/** Called at the end of each agentic turn with the cumulative count. */
	onTurnEnd?: (turnCount: number) => void;
	/** Called once per assistant message_end with that message's usage delta. */
	onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
	/** Called when the session successfully compacts. */
	onCompaction?: (info: CompactionInfo) => void;
	/** Caller-supplied tool-name subset — intersected (never widens). Omit → type default. */
	allowedToolNames?: string[];
	/** Called for config warnings (unknown tool names, extension misconfig). */
	onWarning?: (message: string) => void;
}

export class AgentManager {
	private agents = new Map<string, AgentRecord>();
	private cleanupInterval: ReturnType<typeof setInterval>;
	private onComplete?: OnAgentComplete;
	private onStart?: OnAgentStart;
	private onCompact?: OnAgentCompact;
	private maxConcurrent: number;
	/** Completed-record retention: records older than this are cleaned up. */
	private retentionMs = 10 * 60_000;
	/** Queue of background agents waiting to start. */
	private queue: { id: string; args: SpawnArgs }[] = [];
	/** Number of currently running background agents. */
	private runningBackground = 0;

	constructor(
		onComplete?: OnAgentComplete,
		maxConcurrent = DEFAULT_MAX_CONCURRENT,
		onStart?: OnAgentStart,
		onCompact?: OnAgentCompact,
	) {
		this.onComplete = onComplete;
		this.onStart = onStart;
		this.onCompact = onCompact;
		this.maxConcurrent = maxConcurrent;
		// Periodically clean up completed agents older than retentionMs
		this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
		this.cleanupInterval.unref();
	}

	/** Update the max concurrent background agents limit. */
	setMaxConcurrent(n: number) {
		this.maxConcurrent = Math.max(1, n);
		// Start queued agents if the new limit allows
		this.drainQueue();
	}

	getMaxConcurrent(): number {
		return this.maxConcurrent;
	}

	/** Set completed-record retention in ms (minimum 1 minute). */
	setRetentionMs(n: number) {
		this.retentionMs = Math.max(60_000, n);
	}

	getRetentionMs(): number {
		return this.retentionMs;
	}

	/**
	 * Spawn an agent and return its ID immediately (for background use).
	 * If the concurrency limit is reached, the agent is queued.
	 */
	spawn(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		type: SubagentType,
		prompt: string,
		options: SpawnOptions,
	): string {
		// Validate before the queue branch — a queued spawn should fail at the
		// call, not minutes later at drain. Throw (not warn): programmatic callers
		// can fix and retry; the RPC layer converts throws into error envelopes.
		assertValidSpawnCwd(options.cwd);

		const id = randomUUID().slice(0, 17);
		const abortController = new AbortController();
		const record: AgentRecord = {
			id,
			type,
			description: options.description,
			status: options.isBackground ? "queued" : "running",
			toolUses: 0,
			startedAt: Date.now(),
			abortController,
			lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
			compactionCount: 0,
			turnCount: 0,
			streamingMs: 0,
			maxTurns: options.maxTurns,
			invocation: options.invocation,
			// Persist the invocation mode for UI/notification routing. Use an
			// explicit false for foreground records rather than leaving it unknown.
			isBackground: options.isBackground === true,
		};
		this.agents.set(id, record);

		const args: SpawnArgs = {
			pi,
			ctx,
			type,
			prompt,
			options,
			...(options.isBackground && pi.events
				? {
						endActivity: beginAgentActivity(
							pi.events,
							"subagent",
							`Subagent: ${options.description}`,
						),
					}
				: {}),
		};

		if (
			options.isBackground &&
			!options.bypassQueue &&
			this.runningBackground >= this.maxConcurrent
		) {
			// Queue it — will be started when a running agent completes
			this.queue.push({ id, args });
			return id;
		}

		// startAgent can throw (e.g. strict worktree-isolation failure) — clean
		// up the record so callers don't see an orphan in `listAgents()`.
		try {
			this.startAgent(id, record, args);
		} catch (err) {
			args.endActivity?.();
			this.agents.delete(id);
			throw err;
		}
		return id;
	}

	/** Actually start an agent (called immediately or from queue drain). */
	private startAgent(
		id: string,
		record: AgentRecord,
		{ pi, ctx, type, prompt, options, endActivity }: SpawnArgs,
	) {
		// Re-validate a caller-supplied cwd: queued spawns can start minutes after
		// spawn()'s check, and the directory may be gone by then (TOCTOU). Same
		// curated errors; drainQueue parks a throw on the record as an error.
		assertValidSpawnCwd(options.cwd);
		const customCwd = options.cwd ?? undefined;

		record.status = "running";
		record.startedAt = Date.now();
		if (options.isBackground) this.runningBackground++;
		this.onStart?.(record);

		// Wire parent abort signal to stop the subagent when the parent is interrupted
		let detachParentSignal: (() => void) | undefined;
		if (options.signal) {
			const onParentAbort = () => this.abort(id);
			options.signal.addEventListener("abort", onParentAbort, { once: true });
			detachParentSignal = () => options.signal?.removeEventListener("abort", onParentAbort);
		}
		const detach = () => {
			detachParentSignal?.();
			detachParentSignal = undefined;
		};

		const promise = _runAgentImpl(ctx, type, prompt, {
			pi,
			agentId: id,
			model: options.model,
			maxTurns: options.maxTurns,
			isolated: options.isolated,
			inheritContext: options.inheritContext,
			thinkingLevel: options.thinkingLevel,
			// Worktree wins for the working dir (the agent must run in the copy —
			// which, with a custom cwd, was created from that target). Config stays
			// with the parent project when a caller-supplied cwd is in play; it must
			// stay undefined otherwise so plain worktree runs keep resolving config
			// (incl. relative extension paths and memory) inside the worktree copy.
			cwd: customCwd,
			configCwd: customCwd !== undefined ? ctx.cwd : undefined,
			allowedToolNames: options.allowedToolNames,
			onWarning: options.onWarning,
			signal: record.abortController?.signal,
			onToolActivity: (activity) => {
				if (activity.type === "end") record.toolUses++;
				options.onToolActivity?.(activity);
			},
			onTurnEnd: (turnCount) => {
				record.turnCount = turnCount;
				options.onTurnEnd?.(turnCount);
			},
			onTextDelta: options.onTextDelta,
			onAssistantUsage: (usage) => {
				addUsage(record.lifetimeUsage, usage);
				options.onAssistantUsage?.(usage);
			},
			onCompaction: (info) => {
				record.compactionCount++;
				this.onCompact?.(record, info);
				options.onCompaction?.(info);
			},
			onSessionCreated: (session) => {
				record.session = session;
				// Flush any steers that arrived before the session was ready
				if (record.pendingSteers?.length) {
					for (const msg of record.pendingSteers) {
						session.steer(msg).catch(() => {});
					}
					record.pendingSteers = undefined;
				}
				options.onSessionCreated?.(session);
			},
		})
			.then(({ responseText, session, aborted, steered }) => {
				// Don't overwrite status if externally stopped via abort()
				if (record.status !== "stopped") {
					record.status = aborted ? "aborted" : steered ? "steered" : "completed";
				}
				record.result = responseText;
				record.session = session;
				record.completedAt ??= Date.now();

				detach();

				if (options.isBackground) {
					endActivity?.();
					this.runningBackground--;
					try {
						this.onComplete?.(record);
					} catch {
						/* ignore completion side-effect errors */
					}
					this.drainQueue();
				}
				return responseText;
			})
			.catch((err) => {
				// Don't overwrite status if externally stopped via abort()
				if (record.status !== "stopped") {
					record.status = "error";
				}
				record.error = err instanceof Error ? err.message : String(err);
				record.completedAt ??= Date.now();

				detach();

				if (options.isBackground) {
					endActivity?.();
					this.runningBackground--;
					this.onComplete?.(record);
					this.drainQueue();
				}
				return "";
			});

		record.promise = promise;
	}

	/** Start queued agents up to the concurrency limit. */
	private drainQueue() {
		while (this.queue.length > 0 && this.runningBackground < this.maxConcurrent) {
			const next = this.queue.shift();
			if (!next) break;
			const record = this.agents.get(next.id);
			if (record?.status !== "queued") continue;
			try {
				this.startAgent(next.id, record, next.args);
			} catch (err) {
				next.args.endActivity?.();
				// Late failure (e.g. strict worktree-isolation) — surface on the record
				// so the user/agent can see it via /agents, then keep draining.
				record.status = "error";
				record.error = err instanceof Error ? err.message : String(err);
				record.completedAt = Date.now();
				this.onComplete?.(record);
			}
		}
	}

	/**
	 * Resume an existing agent session with a new prompt.
	 */
	async resume(id: string, prompt: string, signal?: AbortSignal): Promise<AgentRecord | undefined> {
		const record = this.agents.get(id);
		if (!record?.session) return undefined;

		record.status = "running";
		record.startedAt = Date.now();
		record.completedAt = undefined;
		record.result = undefined;
		record.error = undefined;

		try {
			const { responseText, aborted, steered } = await _resumeAgentImpl(record.session, prompt, {
				// Re-apply the original spawn's turn cap for this resume window.
				maxTurns: record.maxTurns,
				onTurnEnd: (turnCount) => {
					record.turnCount = turnCount;
				},
				onToolActivity: (activity) => {
					if (activity.type === "end") record.toolUses++;
				},
				onAssistantUsage: (usage) => {
					addUsage(record.lifetimeUsage, usage);
				},
				onCompaction: (info) => {
					record.compactionCount++;
					this.onCompact?.(record, info);
				},
				signal,
			});
			record.status = aborted ? "aborted" : steered ? "steered" : "completed";
			record.result = responseText;
			record.completedAt = Date.now();
		} catch (err) {
			record.status = "error";
			record.error = err instanceof Error ? err.message : String(err);
			record.completedAt = Date.now();
		}

		return record;
	}

	getRecord(id: string): AgentRecord | undefined {
		return this.agents.get(id);
	}

	listAgents(): AgentRecord[] {
		return [...this.agents.values()].sort((a, b) => b.startedAt - a.startedAt);
	}

	abort(id: string): boolean {
		const record = this.agents.get(id);
		if (!record) return false;

		// Remove from queue if queued
		if (record.status === "queued") {
			const queued = this.queue.find((q) => q.id === id);
			queued?.args.endActivity?.();
			this.queue = this.queue.filter((q) => q.id !== id);
			record.status = "stopped";
			record.completedAt = Date.now();
			return true;
		}

		if (record.status !== "running") return false;
		record.abortController?.abort();
		record.status = "stopped";
		record.completedAt = Date.now();
		return true;
	}

	/** Dispose a record's session and remove it from the map. */
	private removeRecord(id: string, record: AgentRecord): void {
		record.session?.dispose?.();
		record.session = undefined;
		this.agents.delete(id);
	}

	private cleanup() {
		const cutoff = Date.now() - this.retentionMs;
		for (const [id, record] of this.agents) {
			if (record.status === "running" || record.status === "queued") continue;
			if ((record.completedAt ?? 0) >= cutoff) continue;
			this.removeRecord(id, record);
		}
	}

	/**
	 * Remove all completed/stopped/errored records immediately.
	 * Called on session start/switch so tasks from a prior session don't persist.
	 */
	clearCompleted(): void {
		for (const [id, record] of this.agents) {
			if (record.status === "running" || record.status === "queued") continue;
			this.removeRecord(id, record);
		}
	}

	/** Whether any agents are still running or queued. */
	hasRunning(): boolean {
		return [...this.agents.values()].some((r) => r.status === "running" || r.status === "queued");
	}

	/** Abort all running and queued agents immediately. */
	abortAll(): number {
		let count = 0;
		// Clear queued agents first
		for (const queued of this.queue) {
			queued.args.endActivity?.();
			const record = this.agents.get(queued.id);
			if (record) {
				record.status = "stopped";
				record.completedAt = Date.now();
				count++;
			}
		}
		this.queue = [];
		// Abort running agents
		for (const record of this.agents.values()) {
			if (record.status === "running") {
				record.abortController?.abort();
				record.status = "stopped";
				record.completedAt = Date.now();
				count++;
			}
		}
		return count;
	}

	/** Wait for all running and queued agents to complete (including queued ones). */
	async waitForAll(): Promise<void> {
		// Loop because drainQueue respects the concurrency limit — as running
		// agents finish they start queued ones, which need awaiting too.
		while (true) {
			this.drainQueue();
			const pending = [...this.agents.values()]
				.filter((r) => r.status === "running" || r.status === "queued")
				.map((r) => r.promise)
				.filter(Boolean);
			if (pending.length === 0) break;
			await Promise.allSettled(pending);
		}
	}

	dispose() {
		clearInterval(this.cleanupInterval);
		// Clear queue
		this.queue = [];
		for (const record of this.agents.values()) {
			record.session?.dispose();
		}
		this.agents.clear();
	}
}
