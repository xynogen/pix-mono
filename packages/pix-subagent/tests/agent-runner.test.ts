/**
 * agent-runner.test.ts — Unit tests for pure/testable functions exported from
 * agent-runner.ts. These are critical building blocks that the main runAgent()
 * depends on; hardening them prevents subtle regressions.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
	attachTurnLimit,
	extensionCanonicalName,
	getDefaultMaxTurns,
	getGraceTurns,
	narrowTools,
	normalizeMaxTurns,
	parseExtensionsSpec,
	parseExtSelectors,
	resumeAgent,
	setDefaultMaxTurns,
	setGraceTurns,
} from "../src/agent-runner.ts";

test("pre-cancelled resume aborts the session without prompting and cleans subscriptions", async () => {
	let prompts = 0;
	let aborts = 0;
	let subscriptions = 0;
	const session = {
		subscribe: () => {
			subscriptions++;
			return () => {
				subscriptions--;
			};
		},
		abort: async () => {
			aborts++;
		},
		prompt: async () => {
			prompts++;
		},
	} as unknown as AgentSession;
	await expect(
		resumeAgent(session, "do not run", { signal: AbortSignal.abort(new Error("stop resume")) }),
	).rejects.toThrow("stop resume");
	expect({ prompts, aborts, subscriptions }).toEqual({ prompts: 0, aborts: 1, subscriptions: 0 });
});

// ── normalizeMaxTurns ────────────────────────────────────────────────────────

describe("normalizeMaxTurns", () => {
	test("undefined → undefined (unlimited)", () => {
		expect(normalizeMaxTurns(undefined)).toBeUndefined();
	});

	test("0 → undefined (unlimited)", () => {
		expect(normalizeMaxTurns(0)).toBeUndefined();
	});

	test("positive number → same number", () => {
		expect(normalizeMaxTurns(5)).toBe(5);
		expect(normalizeMaxTurns(1)).toBe(1);
		expect(normalizeMaxTurns(100)).toBe(100);
	});

	test("negative number → clamped to 1", () => {
		expect(normalizeMaxTurns(-1)).toBe(1);
		expect(normalizeMaxTurns(-99)).toBe(1);
	});
});

// ── defaultMaxTurns global ───────────────────────────────────────────────────

describe("defaultMaxTurns global", () => {
	afterEach(() => {
		setDefaultMaxTurns(undefined); // reset
	});

	test("initially undefined", () => {
		setDefaultMaxTurns(undefined);
		expect(getDefaultMaxTurns()).toBeUndefined();
	});

	test("set and get roundtrip", () => {
		setDefaultMaxTurns(10);
		expect(getDefaultMaxTurns()).toBe(10);
	});

	test("setting 0 resets to undefined", () => {
		setDefaultMaxTurns(10);
		setDefaultMaxTurns(0);
		expect(getDefaultMaxTurns()).toBeUndefined();
	});
});

// ── graceTurns global ────────────────────────────────────────────────────────

describe("graceTurns global", () => {
	afterEach(() => {
		setGraceTurns(5); // reset to default
	});

	test("default is 5", () => {
		setGraceTurns(5);
		expect(getGraceTurns()).toBe(5);
	});

	test("set and get roundtrip", () => {
		setGraceTurns(10);
		expect(getGraceTurns()).toBe(10);
	});

	test("minimum clamped to 1", () => {
		setGraceTurns(0);
		expect(getGraceTurns()).toBe(1);
		setGraceTurns(-5);
		expect(getGraceTurns()).toBe(1);
	});
});

// ── narrowTools ──────────────────────────────────────────────────────────────

describe("narrowTools", () => {
	test("no allowlist → resolved unchanged", () => {
		const resolved = ["read", "bash", "edit"];
		expect(narrowTools(resolved)).toEqual(["read", "bash", "edit"]);
		expect(narrowTools(resolved, undefined)).toEqual(["read", "bash", "edit"]);
	});

	test("allowlist intersects — only common tools survive", () => {
		expect(narrowTools(["read", "bash", "edit"], ["read", "edit"])).toEqual(["read", "edit"]);
	});

	test("allowlist with extras doesn't widen", () => {
		expect(narrowTools(["read", "bash"], ["read", "bash", "write", "edit"])).toEqual([
			"read",
			"bash",
		]);
	});

	test("empty allowlist → empty", () => {
		expect(narrowTools(["read", "bash", "edit"], [])).toEqual([]);
	});
});

// ── extensionCanonicalName ───────────────────────────────────────────────────

describe("extensionCanonicalName", () => {
	test("single file .ts → basename without extension, lowercased", () => {
		expect(extensionCanonicalName("/path/to/MyExtension.ts")).toBe("myextension");
	});

	test("single file .js → basename without extension, lowercased", () => {
		expect(extensionCanonicalName("foo.js")).toBe("foo");
	});

	test("index.ts → parent directory name, lowercased", () => {
		expect(extensionCanonicalName("/path/to/MyCoolExt/index.ts")).toBe("mycoolext");
	});

	test("index.js → parent directory name, lowercased", () => {
		expect(extensionCanonicalName("/some/dir/index.js")).toBe("dir");
	});

	test("no extension → just basename lowercased", () => {
		expect(extensionCanonicalName("/path/myext")).toBe("myext");
	});
});

// ── parseExtensionsSpec ──────────────────────────────────────────────────────

describe("parseExtensionsSpec", () => {
	test("empty entries → no names, no paths, no wildcard", () => {
		const result = parseExtensionsSpec([], "/cwd");
		expect(result.names.size).toBe(0);
		expect(result.paths.length).toBe(0);
		expect(result.wildcard).toBe(false);
	});

	test("'*' sets wildcard flag", () => {
		const result = parseExtensionsSpec(["*"], "/cwd");
		expect(result.wildcard).toBe(true);
		expect(result.names.size).toBe(0);
	});

	test("plain name (no slash) → added to names set (lowercased)", () => {
		const result = parseExtensionsSpec(["MyExt"], "/cwd");
		expect(result.names.has("myext")).toBe(true);
		expect(result.paths.length).toBe(0);
	});

	test("path entry → resolved to absolute and canonical name added", () => {
		const result = parseExtensionsSpec(["./extensions/foo.ts"], "/cwd");
		expect(result.paths.length).toBe(1);
		expect(result.paths[0]).toBe(resolve("/cwd", "extensions/foo.ts"));
		expect(result.names.has("foo")).toBe(true);
	});

	test("tilde path → expanded to homedir", () => {
		const result = parseExtensionsSpec(["~/ext.ts"], "/cwd");
		expect(result.paths.length).toBe(1);
		expect(result.paths[0]).not.toContain("~");
		expect(result.names.has("ext")).toBe(true);
	});

	test("empty entries are skipped", () => {
		const result = parseExtensionsSpec(["", "foo", ""], "/cwd");
		expect(result.names.size).toBe(1);
		expect(result.names.has("foo")).toBe(true);
	});
});

// ── parseExtSelectors ────────────────────────────────────────────────────────

describe("parseExtSelectors", () => {
	test("empty → no names, no narrowing", () => {
		const result = parseExtSelectors([]);
		expect(result.extNames.size).toBe(0);
		expect(result.narrowing.size).toBe(0);
	});

	test("'ext:foo' → extNames has 'foo', no narrowing", () => {
		const result = parseExtSelectors(["ext:foo"]);
		expect(result.extNames.has("foo")).toBe(true);
		expect(result.narrowing.has("foo")).toBe(false);
	});

	test("'ext:foo/bar' → extNames has 'foo', narrowing has bar", () => {
		const result = parseExtSelectors(["ext:foo/bar"]);
		expect(result.extNames.has("foo")).toBe(true);
		expect(result.narrowing.get("foo")?.has("bar")).toBe(true);
	});

	test("multiple selectors for same ext → narrowing accumulates", () => {
		const result = parseExtSelectors(["ext:foo/bar", "ext:foo/baz"]);
		expect(result.extNames.has("foo")).toBe(true);
		const narrow = result.narrowing.get("foo");
		if (!narrow) throw new Error("expected narrowing for 'foo'");
		expect(narrow.has("bar")).toBe(true);
		expect(narrow.has("baz")).toBe(true);
	});

	test("names are lowercased for case-insensitive matching", () => {
		const result = parseExtSelectors(["ext:MyExt/Tool"]);
		expect(result.extNames.has("myext")).toBe(true);
		// Tool name is NOT lowercased (case-sensitive)
		expect(result.narrowing.get("myext")?.has("Tool")).toBe(true);
	});

	test("empty name entries are skipped", () => {
		const result = parseExtSelectors(["ext:", "ext:/bar"]);
		expect(result.extNames.size).toBe(0);
	});
});

// ── attachTurnLimit ──────────────────────────────────────────────────────────

describe("attachTurnLimit", () => {
	/** Create a minimal fake session that lets us fire events synchronously. */
	function createFakeSession() {
		const listeners: ((event: AgentSessionEvent) => void)[] = [];
		const steeredMessages: string[] = [];
		let aborted = false;

		const session = {
			subscribe(fn: (event: AgentSessionEvent) => void) {
				listeners.push(fn);
				return () => {
					const idx = listeners.indexOf(fn);
					if (idx >= 0) listeners.splice(idx, 1);
				};
			},
			steer(msg: string) {
				steeredMessages.push(msg);
				return Promise.resolve();
			},
			abort() {
				aborted = true;
			},
		} as unknown as AgentSession;

		function emit(event: AgentSessionEvent) {
			for (const fn of listeners) fn(event);
		}

		return {
			session,
			emit,
			getSteered: () => steeredMessages,
			isAborted: () => aborted,
		};
	}

	test("counts turns via onTurnEnd callback", () => {
		const { session, emit } = createFakeSession();
		const turnCounts: number[] = [];

		const handle = attachTurnLimit(session, {
			onTurnEnd: (n) => turnCounts.push(n),
		});

		emit({ type: "turn_end" } as AgentSessionEvent);
		emit({ type: "turn_end" } as AgentSessionEvent);
		emit({ type: "turn_end" } as AgentSessionEvent);

		expect(turnCounts).toEqual([1, 2, 3]);

		handle.unsubscribe();
	});

	test("fires soft steer at maxTurns, hard abort at maxTurns + grace", () => {
		const { session, emit, getSteered, isAborted } = createFakeSession();

		const handle = attachTurnLimit(session, {
			maxTurns: 2,
			graceTurns: 1,
		});

		// Turn 1: under limit
		emit({ type: "turn_end" } as AgentSessionEvent);
		expect(getSteered().length).toBe(0);
		expect(handle.wasSteered()).toBe(false);

		// Turn 2: hits limit → soft steer
		emit({ type: "turn_end" } as AgentSessionEvent);
		expect(getSteered().length).toBe(1);
		expect(handle.wasSteered()).toBe(true);
		expect(handle.wasAborted()).toBe(false);
		expect(isAborted()).toBe(false);

		// Turn 3: maxTurns(2) + graceTurns(1) = 3 → hard abort
		emit({ type: "turn_end" } as AgentSessionEvent);
		expect(handle.wasAborted()).toBe(true);
		expect(isAborted()).toBe(true);

		handle.unsubscribe();
	});

	test("no maxTurns → never steers or aborts", () => {
		const { session, emit, getSteered, isAborted } = createFakeSession();

		const handle = attachTurnLimit(session, {});

		for (let i = 0; i < 100; i++) {
			emit({ type: "turn_end" } as AgentSessionEvent);
		}

		expect(getSteered().length).toBe(0);
		expect(handle.wasSteered()).toBe(false);
		expect(handle.wasAborted()).toBe(false);
		expect(isAborted()).toBe(false);

		handle.unsubscribe();
	});

	test("tracks text deltas via onTextDelta callback", () => {
		const { session, emit } = createFakeSession();
		const deltas: string[] = [];

		const handle = attachTurnLimit(session, {
			onTextDelta: (delta, _full) => deltas.push(delta),
		});

		emit({ type: "message_start" } as AgentSessionEvent);
		emit({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "hello " },
		} as unknown as AgentSessionEvent);
		emit({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "world" },
		} as unknown as AgentSessionEvent);

		expect(deltas).toEqual(["hello ", "world"]);

		handle.unsubscribe();
	});

	test("tracks tool activity via onToolActivity callback", () => {
		const { session, emit } = createFakeSession();
		const activities: { type: string; toolName: string }[] = [];

		const handle = attachTurnLimit(session, {
			onToolActivity: (a) => activities.push(a),
		});

		emit({
			type: "tool_execution_start",
			toolName: "read",
		} as unknown as AgentSessionEvent);
		emit({
			type: "tool_execution_end",
			toolName: "read",
		} as unknown as AgentSessionEvent);

		expect(activities).toEqual([
			{ type: "start", toolName: "read" },
			{ type: "end", toolName: "read" },
		]);

		handle.unsubscribe();
	});

	test("unsubscribe stops event processing", () => {
		const { session, emit } = createFakeSession();
		const turnCounts: number[] = [];

		const handle = attachTurnLimit(session, {
			onTurnEnd: (n) => turnCounts.push(n),
		});

		emit({ type: "turn_end" } as AgentSessionEvent);
		handle.unsubscribe();
		emit({ type: "turn_end" } as AgentSessionEvent);

		// Only one turn should have been recorded
		expect(turnCounts).toEqual([1]);
	});

	test("onAssistantUsage generationMs spans message_start→message_end (covers reasoning)", async () => {
		const { session, emit } = createFakeSession();
		let generationMs = 0;

		const handle = attachTurnLimit(session, {
			onAssistantUsage: (_usage, ms) => {
				generationMs = ms;
			},
		});

		// A thinking model reasons for a while BEFORE any visible text. The window
		// must start at message_start so t/s isn't computed over a tiny text-only
		// slice (which made it wildly high).
		emit({ type: "message_start" } as AgentSessionEvent);
		await new Promise((r) => setTimeout(r, 20));
		emit({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "answer" },
		} as unknown as AgentSessionEvent);
		emit({
			type: "message_end",
			message: { role: "assistant", usage: { input: 1, output: 100, cacheWrite: 0 } },
		} as unknown as AgentSessionEvent);

		// Window includes the ~20ms reasoning gap, not just the near-zero text slice.
		expect(generationMs).toBeGreaterThanOrEqual(15);

		handle.unsubscribe();
	});

	test("message_start resets currentMessageText for onTextDelta", () => {
		const { session, emit } = createFakeSession();
		const fullTexts: string[] = [];

		const handle = attachTurnLimit(session, {
			onTextDelta: (_delta, full) => fullTexts.push(full),
		});

		emit({ type: "message_start" } as AgentSessionEvent);
		emit({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "first" },
		} as unknown as AgentSessionEvent);
		expect(fullTexts).toEqual(["first"]);

		// New message resets
		emit({ type: "message_start" } as AgentSessionEvent);
		emit({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "second" },
		} as unknown as AgentSessionEvent);
		expect(fullTexts).toEqual(["first", "second"]); // "second" not "firstsecond"

		handle.unsubscribe();
	});
});
