/**
 * agent-manager.test.ts — Lifecycle tests for AgentManager queue/abort/drain.
 *
 * Uses the test-only injection point (__setRunAgentForTests) to replace
 * runAgent with a controllable fake, avoiding the need for real sessions.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { type AgentSession, createEventBus } from "@earendil-works/pi-coding-agent";
import {
	__resetAgentRunnersForTests,
	__setResumeAgentForTests,
	__setRunAgentForTests,
	AgentManager,
	DEFAULT_MAX_RETAINED,
	type OnAgentComplete,
	type OnAgentStart,
} from "../src/agent-manager.ts";
import type { ResumeResult, RunResult } from "../src/agent-runner.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal fake session — AgentManager only touches dispose/steer/subscribe/messages. */
function fakeSession(steers?: string[]): AgentSession {
	return {
		dispose() {},
		steer: async (msg: string) => {
			steers?.push(msg);
		},
		subscribe: () => () => {},
		messages: [],
	} as unknown as AgentSession;
}

/** Minimal pi/ctx — our fake runAgent never uses them. */
const pi = {} as never;
const ctx = {} as never;

interface DeferredRunAgent {
	/** Resolve the runAgent promise with a successful result. */
	resolve(text?: string): void;
	/** Reject the runAgent promise. */
	reject(err: Error): void;
	/** The AbortSignal passed to runAgent (for abort assertions). */
	signal?: AbortSignal;
}

/**
 * Install a fake runAgent that captures each call into `calls` and returns a
 * deferred promise the test can resolve/reject at will.
 */
function installFakeRunAgent(steers?: string[]): DeferredRunAgent[] {
	const calls: DeferredRunAgent[] = [];

	__setRunAgentForTests((_ctx, _type, _prompt, options): Promise<RunResult> => {
		// Capture the onSessionCreated callback and fire it with a fake session
		// so the manager wires up the session on the record.
		options.onSessionCreated?.(fakeSession(steers));

		const deferred: DeferredRunAgent = {
			resolve: () => {},
			reject: () => {},
			signal: options.signal,
		};

		const promise = new Promise<RunResult>((resolve, reject) => {
			deferred.resolve = (text = "done") =>
				resolve({
					responseText: text,
					session: fakeSession(),
					aborted: false,
					steered: false,
				});
			deferred.reject = reject;
		});

		calls.push(deferred);
		return promise;
	});

	return calls;
}

// ── Tests ────────────────────────────────────────────────────────────────────

let manager: AgentManager;

afterEach(() => {
	manager?.dispose();
	__resetAgentRunnersForTests();
});

// ── helpers for resume tests ─────────────────────────────────────────────────

interface DeferredResumeAgent {
	resolve(text?: string): void;
	reject(err: Error): void;
	signal?: AbortSignal;
}

function installFakeResumeAgent(): DeferredResumeAgent[] {
	const calls: DeferredResumeAgent[] = [];

	__setResumeAgentForTests((_session, _prompt, opts): Promise<ResumeResult> => {
		const deferred: DeferredResumeAgent = {
			resolve: () => {},
			reject: () => {},
			signal: opts?.signal,
		};
		const promise = new Promise<ResumeResult>((resolve, reject) => {
			deferred.resolve = (text = "resumed") =>
				resolve({ responseText: text, aborted: false, steered: false });
			deferred.reject = reject;
		});
		calls.push(deferred);
		return promise;
	});

	return calls;
}

describe("AgentManager", () => {
	test("background work keeps shared agent state working until completion", async () => {
		const calls = installFakeRunAgent();
		const events = createEventBus();
		const states: string[] = [];
		events.on("pix:agent-state", (event) => states.push((event as { state: string }).state));
		manager = new AgentManager();

		manager.spawn({ events } as never, ctx, "general", "task", {
			description: "background task",
			isBackground: true,
		});
		expect(states.at(-1)).toBe("working");

		calls[0]!.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(states.at(-1)).toBe("idle");
	});

	// 1. Queueing
	test("foreground agents are marked foreground and do not trigger completion notifications", async () => {
		const calls = installFakeRunAgent();
		let completed = 0;
		manager = new AgentManager(() => completed++);

		const id = manager.spawn(pi, ctx, "general", "task", {
			description: "foreground task",
		});

		expect(manager.getRecord(id)?.isBackground).toBeFalse();
		calls[0]!.resolve();
		await new Promise((r) => setTimeout(r, 10));

		expect(manager.getRecord(id)?.status).toBe("completed");
		expect(completed).toBe(0);
	});

	test("with maxConcurrent=1, second bg agent is queued then drains", async () => {
		const calls = installFakeRunAgent();
		manager = new AgentManager(undefined, 1);

		const id1 = manager.spawn(pi, ctx, "general", "task 1", {
			description: "first",
			isBackground: true,
		});
		const id2 = manager.spawn(pi, ctx, "general", "task 2", {
			description: "second",
			isBackground: true,
		});

		expect(manager.getRecord(id1)?.status).toBe("running");
		expect(manager.getRecord(id2)?.status).toBe("queued");

		// Resolve the first agent — should trigger drainQueue → second starts
		calls[0]!.resolve();
		// Allow microtasks to flush
		await new Promise((r) => setTimeout(r, 10));

		expect(manager.getRecord(id1)?.status).toBe("completed");
		expect(manager.getRecord(id2)?.status).toBe("running");

		// Clean up second agent
		calls[1]!.resolve();
		await new Promise((r) => setTimeout(r, 10));
	});

	// 2. abort() on queued agent
	test("abort() on queued agent → stopped, never starts", async () => {
		const calls = installFakeRunAgent();
		manager = new AgentManager(undefined, 1);

		manager.spawn(pi, ctx, "general", "task 1", {
			description: "first",
			isBackground: true,
		});
		const queuedId = manager.spawn(pi, ctx, "general", "task 2", {
			description: "second",
			isBackground: true,
		});

		expect(manager.getRecord(queuedId)?.status).toBe("queued");
		manager.abort(queuedId);
		expect(manager.getRecord(queuedId)?.status).toBe("stopped");

		// Resolve the first and wait — the second should NOT start
		calls[0]!.resolve();
		await new Promise((r) => setTimeout(r, 10));
		// Only 1 call to runAgent (the second was never started)
		expect(calls.length).toBe(1);
	});

	// 3. abort() on running agent
	test("abort() on running agent → stopped, abortController fired", () => {
		const calls = installFakeRunAgent();
		manager = new AgentManager(undefined, 4);

		const id = manager.spawn(pi, ctx, "general", "task", {
			description: "run",
			isBackground: true,
		});

		expect(manager.getRecord(id)?.status).toBe("running");
		// The signal passed to the fake should not be aborted yet
		expect(calls[0]!.signal?.aborted).toBe(false);

		manager.abort(id);
		expect(manager.getRecord(id)?.status).toBe("stopped");
		expect(calls[0]!.signal?.aborted).toBe(true);
	});

	// 4. spawn cwd validation
	// requestStop: graceful stop steers a summarize message, keeps agent running
	test("requestStop() on running agent → steers summarize, stays running", () => {
		const steers: string[] = [];
		const calls = installFakeRunAgent(steers);
		manager = new AgentManager(undefined, 4);

		const id = manager.spawn(pi, ctx, "general", "task", {
			description: "run",
			isBackground: true,
		});

		expect(manager.requestStop(id)).toBe("steered");
		// Steered, not killed: the abort signal must NOT be fired.
		expect(calls[0]!.signal?.aborted).toBe(false);
		expect(manager.getRecord(id)?.status).toBe("running");
		expect(steers).toHaveLength(1);
		expect(steers[0]).toContain("Summarize");
	});

	// requestStop on a queued agent has nothing to summarize → plain abort
	test("requestStop() on queued agent → not-running, aborted", async () => {
		const calls = installFakeRunAgent();
		manager = new AgentManager(undefined, 1);

		manager.spawn(pi, ctx, "general", "task 1", { description: "first", isBackground: true });
		const queuedId = manager.spawn(pi, ctx, "general", "task 2", {
			description: "second",
			isBackground: true,
		});

		expect(manager.getRecord(queuedId)?.status).toBe("queued");
		expect(manager.requestStop(queuedId)).toBe("not-running");
		expect(manager.getRecord(queuedId)?.status).toBe("stopped");

		calls[0]!.resolve();
		await new Promise((r) => setTimeout(r, 10));
		expect(calls.length).toBe(1); // queued one never started
	});

	test("requestStop() on unknown id → not-running", () => {
		installFakeRunAgent();
		manager = new AgentManager(undefined, 4);
		expect(manager.requestStop("nope")).toBe("not-running");
	});

	test("spawn with relative cwd throws", () => {
		installFakeRunAgent();
		manager = new AgentManager(undefined, 4);
		expect(() =>
			manager.spawn(pi, ctx, "general", "task", {
				description: "test",
				cwd: "relative/path",
			}),
		).toThrow("absolute path");
	});

	test("spawn with non-existent absolute cwd throws", () => {
		installFakeRunAgent();
		manager = new AgentManager(undefined, 4);
		expect(() =>
			manager.spawn(pi, ctx, "general", "task", {
				description: "test",
				cwd: "/nonexistent-dir-xyz",
			}),
		).toThrow("does not exist");
	});

	test("spawn with undefined cwd is fine", () => {
		installFakeRunAgent();
		manager = new AgentManager(undefined, 4);
		// Should not throw
		const id = manager.spawn(pi, ctx, "general", "task", {
			description: "test",
			cwd: undefined,
		});
		expect(id).toBeTruthy();
	});

	// 5. abortAll()
	test("abortAll() stops 1 running + 1 queued, returns 2", async () => {
		const calls = installFakeRunAgent();
		manager = new AgentManager(undefined, 1);

		manager.spawn(pi, ctx, "general", "task 1", {
			description: "first",
			isBackground: true,
		});
		manager.spawn(pi, ctx, "general", "task 2", {
			description: "second",
			isBackground: true,
		});

		const count = manager.abortAll();
		expect(count).toBe(2);

		// Both should be stopped
		const agents = manager.listAgents();
		expect(agents.every((a) => a.status === "stopped")).toBe(true);

		// Clean up — resolve the first's promise so the .catch handler runs
		calls[0]!.resolve();
		await new Promise((r) => setTimeout(r, 10));
	});

	// 6. clearCompleted()
	test("clearCompleted removes completed record, keeps running", async () => {
		const calls = installFakeRunAgent();
		manager = new AgentManager(undefined, 4);

		const idA = manager.spawn(pi, ctx, "general", "task 1", {
			description: "first",
			isBackground: true,
		});
		const idB = manager.spawn(pi, ctx, "general", "task 2", {
			description: "second",
			isBackground: true,
		});

		// Complete the first agent
		calls[0]!.resolve();
		await new Promise((r) => setTimeout(r, 10));
		expect(manager.getRecord(idA)?.status).toBe("completed");
		expect(manager.getRecord(idB)?.status).toBe("running");

		manager.clearCompleted();

		expect(manager.getRecord(idA)).toBeUndefined();
		expect(manager.getRecord(idB)).toBeDefined();
		expect(manager.getRecord(idB)?.status).toBe("running");

		calls[1]!.resolve();
		await new Promise((r) => setTimeout(r, 10));
	});

	// 7. error path
	test("runAgent rejection → error status, error message, onComplete fired", async () => {
		let completedRecord: unknown = null;
		const onComplete: OnAgentComplete = (record) => {
			completedRecord = record;
		};

		const calls = installFakeRunAgent();
		manager = new AgentManager(onComplete, 4);

		const id = manager.spawn(pi, ctx, "general", "task", {
			description: "will fail",
			isBackground: true,
		});

		calls[0]!.reject(new Error("kaboom"));
		await new Promise((r) => setTimeout(r, 10));

		const record = manager.getRecord(id);
		expect(record?.status).toBe("error");
		expect(record?.error).toBe("kaboom");
		expect(completedRecord).toBeDefined();
	});

	// ── resume ───────────────────────────────────────────────────────────────

	test("resume() returns undefined for non-existent id", async () => {
		installFakeRunAgent();
		manager = new AgentManager(undefined, 4);
		const result = await manager.resume("does-not-exist", "hello");
		expect(result).toBeUndefined();
	});

	test("resume() returns undefined when record has no session", async () => {
		const calls = installFakeRunAgent();
		manager = new AgentManager(undefined, 4);

		const id = manager.spawn(pi, ctx, "general", "task", {
			description: "test",
			isBackground: true,
		});

		// Complete the agent
		calls[0]!.resolve();
		await new Promise((r) => setTimeout(r, 10));

		// Manually remove session to simulate no-session state
		const record = manager.getRecord(id);
		if (record) record.session = undefined;

		const result = await manager.resume(id, "new prompt");
		expect(result).toBeUndefined();
	});

	test("resume() runs the resumed prompt and returns completed record", async () => {
		const runCalls = installFakeRunAgent();
		const resumeCalls = installFakeResumeAgent();
		manager = new AgentManager(undefined, 4);

		const id = manager.spawn(pi, ctx, "general", "task", {
			description: "test",
			isBackground: true,
		});

		// Complete the initial run so session is wired
		runCalls[0]!.resolve("initial result");
		await new Promise((r) => setTimeout(r, 10));

		const resumed = manager.resume(id, "continue working");
		resumeCalls[0]!.resolve("resumed output");
		const record = await resumed;

		expect(record).toMatchObject({ status: "completed", result: "resumed output" });
	});

	test("resume() sets error status on rejection", async () => {
		const runCalls = installFakeRunAgent();
		const resumeCalls = installFakeResumeAgent();
		manager = new AgentManager(undefined, 4);

		const id = manager.spawn(pi, ctx, "general", "task", {
			description: "test",
			isBackground: true,
		});

		runCalls[0]!.resolve();
		await new Promise((r) => setTimeout(r, 10));

		const resumed = manager.resume(id, "continue");
		resumeCalls[0]!.reject(new Error("resume failed"));
		const record = await resumed;

		expect(record).toMatchObject({ status: "error", error: "resume failed" });
	});

	test("resume() is refused while the agent is still running", async () => {
		const runCalls = installFakeRunAgent();
		const resumeCalls = installFakeResumeAgent();
		manager = new AgentManager(undefined, 4);
		const id = manager.spawn(pi, ctx, "general", "task", { description: "t", isBackground: true });

		expect(await manager.resume(id, "too early")).toBe("busy");
		expect(resumeCalls).toHaveLength(0);
		runCalls[0]!.resolve();
	});

	test("resume() is refused after a stop until the old run settles", async () => {
		const runCalls = installFakeRunAgent();
		const resumeCalls = installFakeResumeAgent();
		manager = new AgentManager(undefined, 4);
		const id = manager.spawn(pi, ctx, "general", "task", { description: "t", isBackground: true });

		manager.abort(id); // status flips to stopped; the run promise is still pending
		expect(manager.getRecord(id)?.status).toBe("stopped");
		expect(await manager.resume(id, "race")).toBe("busy");

		runCalls[0]!.resolve();
		await manager.getRecord(id)?.promise;
		const resumed = manager.resume(id, "now");
		resumeCalls[0]!.resolve("ok");
		expect(await resumed).toMatchObject({ status: "completed", result: "ok" });
	});

	test("stopping a resumed agent aborts that run and stays stopped", async () => {
		const runCalls = installFakeRunAgent();
		const resumeCalls = installFakeResumeAgent();
		manager = new AgentManager(undefined, 4);
		const id = manager.spawn(pi, ctx, "general", "task", { description: "t", isBackground: true });
		runCalls[0]!.resolve();
		await manager.getRecord(id)?.promise;

		const resumed = manager.resume(id, "long job");
		expect(manager.abort(id)).toBe(true);
		expect(resumeCalls[0]!.signal?.aborted).toBe(true);
		resumeCalls[0]!.resolve("partial");
		expect(await resumed).toMatchObject({ status: "stopped", result: "partial" });
	});

	test("a resume that fails after a stop keeps the stopped status", async () => {
		const runCalls = installFakeRunAgent();
		const resumeCalls = installFakeResumeAgent();
		manager = new AgentManager(undefined, 4);
		const id = manager.spawn(pi, ctx, "general", "task", { description: "t", isBackground: true });
		runCalls[0]!.resolve();
		await manager.getRecord(id)?.promise;

		const resumed = manager.resume(id, "job");
		manager.abort(id);
		resumeCalls[0]!.reject(new Error("aborted"));
		expect(await resumed).toMatchObject({ status: "stopped", error: "aborted" });
	});

	// ── hasRunning ──────────────────────────────────────────────────────────

	test("hasRunning() returns false with no agents", () => {
		manager = new AgentManager(undefined, 4);
		expect(manager.hasRunning()).toBe(false);
	});

	test("hasRunning() returns true when an agent is running", () => {
		installFakeRunAgent();
		manager = new AgentManager(undefined, 4);
		manager.spawn(pi, ctx, "general", "task", {
			description: "test",
			isBackground: true,
		});
		expect(manager.hasRunning()).toBe(true);
	});

	test("hasRunning() returns true when an agent is queued", () => {
		installFakeRunAgent();
		manager = new AgentManager(undefined, 1);
		manager.spawn(pi, ctx, "general", "task 1", {
			description: "first",
			isBackground: true,
		});
		manager.spawn(pi, ctx, "general", "task 2", {
			description: "second",
			isBackground: true,
		});
		expect(manager.hasRunning()).toBe(true);
	});

	test("hasRunning() returns false after all agents complete", async () => {
		const calls = installFakeRunAgent();
		manager = new AgentManager(undefined, 4);
		manager.spawn(pi, ctx, "general", "task", {
			description: "test",
			isBackground: true,
		});
		calls[0]!.resolve();
		await new Promise((r) => setTimeout(r, 10));
		expect(manager.hasRunning()).toBe(false);
	});

	// ── waitForAll ─────────────────────────────────────────────────────────

	test("waitForAll() resolves when all agents complete", async () => {
		const calls = installFakeRunAgent();
		manager = new AgentManager(undefined, 4);

		manager.spawn(pi, ctx, "general", "task 1", {
			description: "first",
			isBackground: true,
		});
		manager.spawn(pi, ctx, "general", "task 2", {
			description: "second",
			isBackground: true,
		});

		// Resolve both after a tick
		setTimeout(() => {
			calls[0]!.resolve();
			calls[1]!.resolve();
		}, 5);

		await manager.waitForAll();

		expect(manager.hasRunning()).toBe(false);
		const agents = manager.listAgents();
		expect(agents.every((a) => a.status === "completed")).toBe(true);
	});

	test("waitForAll() drains queue (maxConcurrent=1, 2 agents)", async () => {
		const calls = installFakeRunAgent();
		manager = new AgentManager(undefined, 1);

		manager.spawn(pi, ctx, "general", "task 1", {
			description: "first",
			isBackground: true,
		});
		manager.spawn(pi, ctx, "general", "task 2", {
			description: "second",
			isBackground: true,
		});

		// Resolve agents as they start
		setTimeout(() => calls[0]!.resolve(), 5);
		setTimeout(() => calls[1]?.resolve(), 20);

		await manager.waitForAll();

		expect(manager.hasRunning()).toBe(false);
		expect(calls.length).toBe(2); // both were actually started
	});

	// ── listAgents ordering ────────────────────────────────────────────────

	test("listAgents() returns all spawned agents", () => {
		installFakeRunAgent();
		manager = new AgentManager(undefined, 4);

		const id1 = manager.spawn(pi, ctx, "general", "task 1", {
			description: "first",
			isBackground: true,
		});
		const id2 = manager.spawn(pi, ctx, "general", "task 2", {
			description: "second",
			isBackground: true,
		});

		const list = manager.listAgents();
		expect(list.length).toBe(2);
		const ids = list.map((a) => a.id);
		expect(ids).toContain(id1);
		expect(ids).toContain(id2);
		// Sorted by startedAt descending — both may have same timestamp,
		// but the invariant is that newer agents come first or equal.
		expect(list[0]!.startedAt).toBeGreaterThanOrEqual(list[1]!.startedAt);
	});

	// ── getRecord ──────────────────────────────────────────────────────────

	test("getRecord() returns undefined for non-existent id", () => {
		manager = new AgentManager(undefined, 4);
		expect(manager.getRecord("nope")).toBeUndefined();
	});

	// ── onStart callback ───────────────────────────────────────────────────

	test("onStart callback fires when agent starts running", () => {
		installFakeRunAgent();
		const started: string[] = [];
		const onStart: OnAgentStart = (record) => {
			started.push(record.id);
		};
		manager = new AgentManager(undefined, 4, onStart);

		const id = manager.spawn(pi, ctx, "general", "task", {
			description: "test",
			isBackground: true,
		});

		expect(started).toEqual([id]);
	});

	test("onStart callback fires for queued agent when it drains", async () => {
		const calls = installFakeRunAgent();
		const started: string[] = [];
		const onStart: OnAgentStart = (record) => {
			started.push(record.id);
		};
		manager = new AgentManager(undefined, 1, onStart);

		const id1 = manager.spawn(pi, ctx, "general", "task 1", {
			description: "first",
			isBackground: true,
		});
		const id2 = manager.spawn(pi, ctx, "general", "task 2", {
			description: "second",
			isBackground: true,
		});

		// Only the first started so far
		expect(started).toEqual([id1]);

		// Drain: resolve first → second starts
		calls[0]!.resolve();
		await new Promise((r) => setTimeout(r, 10));

		expect(started).toEqual([id1, id2]);

		calls[1]!.resolve();
		await new Promise((r) => setTimeout(r, 10));
	});

	// ── bypassQueue ────────────────────────────────────────────────────────

	test("bypassQueue: true starts immediately even at concurrency limit", () => {
		installFakeRunAgent();
		manager = new AgentManager(undefined, 1);

		// Fill the single slot
		manager.spawn(pi, ctx, "general", "task 1", {
			description: "first",
			isBackground: true,
		});

		// Bypass should start immediately despite limit
		const bypassId = manager.spawn(pi, ctx, "general", "task 2", {
			description: "bypass",
			isBackground: true,
			bypassQueue: true,
		});

		expect(manager.getRecord(bypassId)?.status).toBe("running");
	});

	test("without bypassQueue, excess agents are queued", () => {
		installFakeRunAgent();
		manager = new AgentManager(undefined, 1);

		manager.spawn(pi, ctx, "general", "task 1", {
			description: "first",
			isBackground: true,
		});

		const queuedId = manager.spawn(pi, ctx, "general", "task 2", {
			description: "normal",
			isBackground: true,
		});

		expect(manager.getRecord(queuedId)?.status).toBe("queued");
	});

	// ── setMaxConcurrent ───────────────────────────────────────────────────

	test("setMaxConcurrent drains queue when limit is raised", async () => {
		const calls = installFakeRunAgent();
		manager = new AgentManager(undefined, 1);

		manager.spawn(pi, ctx, "general", "task 1", {
			description: "first",
			isBackground: true,
		});
		const id2 = manager.spawn(pi, ctx, "general", "task 2", {
			description: "second",
			isBackground: true,
		});

		expect(manager.getRecord(id2)?.status).toBe("queued");

		// Raise limit → should immediately drain the queue
		manager.setMaxConcurrent(2);
		expect(manager.getRecord(id2)?.status).toBe("running");

		// Clean up
		calls[0]!.resolve();
		calls[1]!.resolve();
		await new Promise((r) => setTimeout(r, 10));
	});

	test("getMaxConcurrent returns the configured limit", () => {
		manager = new AgentManager(undefined, 7);
		expect(manager.getMaxConcurrent()).toBe(7);
		manager.setMaxConcurrent(3);
		expect(manager.getMaxConcurrent()).toBe(3);
	});

	// ── pendingSteers ─────────────────────────────────────────────────────

	test("steers queued before session ready are flushed on session creation", async () => {
		const steeredMessages: string[] = [];
		__setRunAgentForTests((_ctx, _type, _prompt, options): Promise<RunResult> => {
			// Delay session creation to simulate async startup
			const session = {
				dispose() {},
				steer: async (msg: string) => {
					steeredMessages.push(msg);
				},
				subscribe: () => () => {},
				messages: [],
			} as unknown as AgentSession;

			return new Promise<RunResult>((resolve) => {
				// Fire session after a delay so pendingSteers can accumulate
				setTimeout(() => {
					options.onSessionCreated?.(session);
					setTimeout(
						() =>
							resolve({
								responseText: "done",
								session,
								aborted: false,
								steered: false,
							}),
						10,
					);
				}, 30);
			});
		});

		manager = new AgentManager(undefined, 4);

		const id = manager.spawn(pi, ctx, "general", "task", {
			description: "test",
			isBackground: true,
		});

		// Record exists but session isn't created yet — steer should queue
		const record = manager.getRecord(id);
		if (!record) throw new Error("expected record to exist");
		record.session = undefined; // force no session state
		record.pendingSteers = ["redirect to X", "also check Y"];

		// Wait for session creation + flushing
		await new Promise((r) => setTimeout(r, 60));

		expect(steeredMessages).toContain("redirect to X");
		expect(steeredMessages).toContain("also check Y");
	});

	// ── dispose ────────────────────────────────────────────────────────────

	test("dispose() clears all agents and queue", () => {
		installFakeRunAgent();
		manager = new AgentManager(undefined, 1);

		manager.spawn(pi, ctx, "general", "task 1", {
			description: "first",
			isBackground: true,
		});
		manager.spawn(pi, ctx, "general", "task 2", {
			description: "second",
			isBackground: true,
		});

		manager.dispose();

		expect(manager.listAgents()).toEqual([]);
		expect(manager.hasRunning()).toBe(false);
	});

	// ── abort edge cases ───────────────────────────────────────────────────

	test("abort() returns false for non-existent id", () => {
		manager = new AgentManager(undefined, 4);
		expect(manager.abort("nope")).toBe(false);
	});

	test("abort() returns false for already-completed agent", async () => {
		const calls = installFakeRunAgent();
		manager = new AgentManager(undefined, 4);

		const id = manager.spawn(pi, ctx, "general", "task", {
			description: "test",
			isBackground: true,
		});

		calls[0]!.resolve();
		await new Promise((r) => setTimeout(r, 10));

		expect(manager.abort(id)).toBe(false);
	});

	// ── record fields populated correctly ───────────────────────────────────

	test("spawn sets initial record fields correctly", () => {
		installFakeRunAgent();
		manager = new AgentManager(undefined, 4);

		const before = Date.now();
		const id = manager.spawn(pi, ctx, "general", "task", {
			description: "my task",
			isBackground: true,
			maxTurns: 15,
		});
		const after = Date.now();

		const record = manager.getRecord(id);
		if (!record) throw new Error("expected record to exist");
		expect(record.type).toBe("general");
		expect(record.description).toBe("my task");
		expect(record.status).toBe("running");
		expect(record.toolUses).toBe(0);
		expect(record.turnCount).toBe(0);
		expect(record.compactionCount).toBe(0);
		expect(record.streamingMs).toBe(0);
		expect(record.maxTurns).toBe(15);
		expect(record.startedAt).toBeGreaterThanOrEqual(before);
		expect(record.startedAt).toBeLessThanOrEqual(after);
		expect(record.lifetimeUsage).toEqual({
			input: 0,
			output: 0,
			cacheWrite: 0,
		});
	});

	// ── completion sets fields ──────────────────────────────────────────────

	test("completion sets result and completedAt", async () => {
		const calls = installFakeRunAgent();
		manager = new AgentManager(undefined, 4);

		const id = manager.spawn(pi, ctx, "general", "task", {
			description: "test",
			isBackground: true,
		});

		const before = Date.now();
		calls[0]!.resolve("the answer");
		await new Promise((r) => setTimeout(r, 10));
		const after = Date.now();

		const record = manager.getRecord(id);
		if (!record) throw new Error("expected record to exist");
		expect(record.status).toBe("completed");
		expect(record.result).toBe("the answer");
		expect(record.completedAt).toBeGreaterThanOrEqual(before);
		expect(record.completedAt).toBeLessThanOrEqual(after);
	});

	// ── maxRetained ring buffer ────────────────────────────────────────────

	const spawnBg = (i: number) =>
		manager.spawn(pi, ctx, "general", `task ${i}`, {
			description: `agent ${i}`,
			isBackground: true,
		});
	/** Settle the record's promise so the .then/.catch finalizer has run. */
	const settle = (id: string) => manager.getRecord(id)?.promise;

	test("default cap is DEFAULT_MAX_RETAINED (4); setter floors at 1", () => {
		manager = new AgentManager();
		expect(manager.getMaxRetained()).toBe(DEFAULT_MAX_RETAINED);
		expect(DEFAULT_MAX_RETAINED).toBe(4);
		manager.setMaxRetained(0);
		expect(manager.getMaxRetained()).toBe(1);
		manager.setMaxRetained(2.9);
		expect(manager.getMaxRetained()).toBe(2);
	});

	test("keeps exactly the last N finished, FIFO eviction", async () => {
		const calls = installFakeRunAgent();
		manager = new AgentManager(undefined, 10);
		const ids = [0, 1, 2, 3, 4, 5].map(spawnBg);

		for (let i = 0; i < ids.length; i++) {
			calls[i]!.resolve(`r${i}`);
			await settle(ids[i]!);
		}

		// 6 finished, cap 4 → the two oldest are gone, newest four survive intact.
		expect(manager.getRecord(ids[0]!)).toBeUndefined();
		expect(manager.getRecord(ids[1]!)).toBeUndefined();
		expect(ids.slice(2).map((id) => manager.getRecord(id)?.result)).toEqual([
			"r2",
			"r3",
			"r4",
			"r5",
		]);
	});

	test("eviction counts every terminal path: error, abort, abortAll", async () => {
		const calls = installFakeRunAgent();
		manager = new AgentManager(undefined, 10);
		manager.setMaxRetained(2);
		const [a, b, c, d] = [0, 1, 2, 3].map(spawnBg) as [string, string, string, string];

		calls[0]!.resolve();
		await settle(a); // completed
		calls[1]!.reject(new Error("boom"));
		await settle(b); // error
		manager.abort(c); // stopped (sync)
		expect(manager.getRecord(a)).toBeUndefined(); // cap 2: a evicted after c
		expect(manager.getRecord(b)?.status).toBe("error");
		expect(manager.getRecord(c)?.status).toBe("stopped");

		manager.abortAll(); // d stopped
		expect(manager.getRecord(b)).toBeUndefined();
		expect(manager.getRecord(c)?.status).toBe("stopped");
		expect(manager.getRecord(d)?.status).toBe("stopped");

		// Settle the aborted promises so no dangling handlers leak into other tests.
		calls[2]!.resolve();
		calls[3]!.resolve();
		await Promise.allSettled([settle(c), settle(d)]);
	});

	test("running and queued agents never count toward or fall out of the cap", async () => {
		const calls = installFakeRunAgent();
		manager = new AgentManager(undefined, 1); // force queueing
		manager.setMaxRetained(1);
		const running = spawnBg(0);
		const queued = spawnBg(1);
		expect(manager.getRecord(queued)?.status).toBe("queued");

		// Lower the cap far below the live count — nothing live may be evicted.
		manager.setMaxRetained(1);
		expect(manager.getRecord(running)?.status).toBe("running");
		expect(manager.getRecord(queued)?.status).toBe("queued");

		calls[0]!.resolve();
		await settle(running); // running finishes → queued starts
		calls[1]!.resolve();
		await settle(queued);

		// Cap 1: the first finisher is evicted, the second retained.
		expect(manager.getRecord(running)).toBeUndefined();
		expect(manager.getRecord(queued)?.status).toBe("completed");
	});

	test("evicted record's session is disposed", async () => {
		const calls = installFakeRunAgent();
		manager = new AgentManager(undefined, 10);
		manager.setMaxRetained(1);
		const [a, b] = [0, 1].map(spawnBg) as [string, string];

		calls[0]!.resolve();
		await settle(a);
		let disposed = false;
		const rec = manager.getRecord(a);
		if (!rec?.session) throw new Error("expected session");
		rec.session.dispose = () => {
			disposed = true;
		};

		calls[1]!.resolve();
		await settle(b);
		expect(manager.getRecord(a)).toBeUndefined();
		expect(disposed).toBe(true);
	});

	test("lowering the cap trims immediately", async () => {
		const calls = installFakeRunAgent();
		manager = new AgentManager(undefined, 10);
		const ids = [0, 1, 2].map(spawnBg);
		for (let i = 0; i < ids.length; i++) {
			calls[i]!.resolve();
			await settle(ids[i]!);
		}
		expect(manager.listAgents()).toHaveLength(3);

		manager.setMaxRetained(1);
		expect(manager.listAgents().map((r) => r.id)).toEqual([ids[2]!]);
	});

	test("resume re-ranks the record as the newest finisher", async () => {
		const calls = installFakeRunAgent();
		const resumes = installFakeResumeAgent();
		manager = new AgentManager(undefined, 10);
		manager.setMaxRetained(2);
		const [a, b, c] = [0, 1, 2].map(spawnBg) as [string, string, string];

		calls[0]!.resolve();
		await settle(a);
		calls[1]!.resolve();
		await settle(b);

		// Resume `a` — it becomes the newest finisher, so `b` is now oldest.
		const resumed = manager.resume(a, "again");
		resumes[0]!.resolve("a2");
		await resumed;

		calls[2]!.resolve();
		await settle(c);
		expect(manager.getRecord(b)).toBeUndefined();
		expect(manager.getRecord(a)?.result).toBe("a2");
		expect(manager.getRecord(c)?.status).toBe("completed");
	});
});
