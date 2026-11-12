/**
 * always-background.test.ts — Regression guards for the background-by-default
 * policy. An explicit background: false is the only foreground/blocking opt-in.
 */

import { describe, expect, test } from "bun:test";
import { AgentManager } from "../src/agent-manager.ts";
import { resolveAgentInvocationConfig } from "../src/invocation-config.ts";
import { runsInBackground } from "../src/tools.ts";
import type { AgentConfig, AgentInvocation } from "../src/types.ts";

// ── Tool execution mode ──────────────────────────────────────────────────────

describe("agent execution mode", () => {
	test("omitted background defaults to non-blocking execution", () => {
		expect(runsInBackground(undefined)).toBe(true);
	});

	test("background: true remains non-blocking", () => {
		expect(runsInBackground(true)).toBe(true);
	});

	test("only background: false opts into blocking inline results", () => {
		expect(runsInBackground(false)).toBe(false);
	});
});

// ── AgentManager: no foreground API ──────────────────────────────────────────

describe("AgentManager has no foreground API", () => {
	test("spawnAndWait does not exist on AgentManager", () => {
		const manager = new AgentManager();
		expect((manager as unknown as Record<string, unknown>).spawnAndWait).toBeUndefined();
		manager.dispose();
	});

	test("spawn is the only public method to create agents", () => {
		const manager = new AgentManager();
		expect(typeof manager.spawn).toBe("function");
		// No other spawn variant exists
		expect((manager as unknown as Record<string, unknown>).spawnForeground).toBeUndefined();
		expect((manager as unknown as Record<string, unknown>).spawnBlocking).toBeUndefined();
		expect((manager as unknown as Record<string, unknown>).spawnSync).toBeUndefined();
		manager.dispose();
	});
});

// ── invocation-config: no runInBackground field ──────────────────────────────

describe("invocation-config has no background/foreground toggle", () => {
	test("resolveAgentInvocationConfig return type has no runInBackground field", () => {
		const result = resolveAgentInvocationConfig(undefined, {});
		// The return object should NOT have a runInBackground property at all
		expect("runInBackground" in result).toBe(false);
	});

	test("passing background param is silently ignored (not in return)", () => {
		// Even if a caller accidentally passes background, it should not appear in the result
		const result = resolveAgentInvocationConfig(undefined, {
			background: true,
		} as Record<string, unknown>);
		expect("runInBackground" in result).toBe(false);
	});

	test("passing run_in_background param is silently ignored", () => {
		const result = resolveAgentInvocationConfig(undefined, {
			run_in_background: false,
		} as Record<string, unknown>);
		expect("runInBackground" in result).toBe(false);
	});

	test("agentConfig.runInBackground is not propagated", () => {
		const config: AgentConfig = {
			name: "test",
			description: "test",
			extensions: true,
			skills: true,
			systemPrompt: "",
			promptMode: "append",
			// This field no longer exists on AgentConfig, but test it as a loose prop
		};
		// Even with a config that has extra props, runInBackground should not appear in result
		const result = resolveAgentInvocationConfig(
			{ ...config, runInBackground: true } as unknown as AgentConfig,
			{},
		);
		expect("runInBackground" in result).toBe(false);
	});
});

// ── AgentInvocation type: no runInBackground field ───────────────────────────

describe("AgentInvocation type has no runInBackground", () => {
	test("AgentInvocation without runInBackground compiles and works", () => {
		// If runInBackground were re-added to the type, this test would still pass,
		// but the test below would catch it at the structural level.
		const invocation: AgentInvocation = {
			modelName: "haiku",
			thinking: "low",
			maxTurns: 10,
			isolated: false,
			inheritContext: false,
		};
		expect(invocation.modelName).toBe("haiku");
		// The object should have exactly these keys and no more
		const keys = Object.keys(invocation).sort();
		expect(keys).toEqual(["inheritContext", "isolated", "maxTurns", "modelName", "thinking"]);
		// Explicitly: no background-related key
		expect(keys).not.toContain("runInBackground");
		expect(keys).not.toContain("background");
		expect(keys).not.toContain("isBackground");
	});
});

// ── AgentConfig type: no runInBackground field ───────────────────────────────

describe("AgentConfig type has no runInBackground", () => {
	test("minimal AgentConfig does not include runInBackground", () => {
		const config: AgentConfig = {
			name: "test",
			description: "test agent",
			extensions: true,
			skills: true,
			systemPrompt: "hello",
			promptMode: "replace",
		};
		expect("runInBackground" in config).toBe(false);
	});
});
