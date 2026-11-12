/**
 * invocation-config.test.ts — Precedence and field-level tests for
 * resolveAgentInvocationConfig. Hardens the "no background toggle" invariant
 * and verifies caller > config > subagent default precedence for all fields.
 */

import { describe, expect, test } from "bun:test";
import { resolveAgentInvocationConfig } from "../src/invocation-config.ts";
import type { AgentConfig } from "../src/types.ts";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "test",
		description: "test agent",
		extensions: true,
		skills: true,
		systemPrompt: "",
		promptMode: "append",
		...overrides,
	};
}

// ── return shape ─────────────────────────────────────────────────────────────

describe("return shape", () => {
	test("returns exactly the expected keys", () => {
		const result = resolveAgentInvocationConfig(undefined, {});
		const keys = Object.keys(result).sort();
		expect(keys).toEqual([
			"inheritContext",
			"isolated",
			"maxTurns",
			"modelFromParams",
			"modelInput",
			"thinking",
		]);
	});

	test("does NOT include runInBackground in return", () => {
		const result = resolveAgentInvocationConfig(undefined, {});
		expect("runInBackground" in result).toBe(false);
	});

	test("does NOT include background in return", () => {
		const result = resolveAgentInvocationConfig(undefined, {});
		expect("background" in result).toBe(false);
	});
});

// ── model precedence ─────────────────────────────────────────────────────────

describe("model precedence", () => {
	test("params.model wins over config.model", () => {
		const r = resolveAgentInvocationConfig(makeConfig({ model: "config-model" }), {
			model: "param-model",
		});
		expect(r.modelInput).toBe("param-model");
		expect(r.modelFromParams).toBe(true);
	});

	test("config.model used when params.model is absent", () => {
		const r = resolveAgentInvocationConfig(makeConfig({ model: "config-model" }), {});
		expect(r.modelInput).toBe("config-model");
		expect(r.modelFromParams).toBe(false);
	});

	test("modelInput is undefined when both absent", () => {
		const r = resolveAgentInvocationConfig(makeConfig(), {});
		expect(r.modelInput).toBeUndefined();
		expect(r.modelFromParams).toBe(false);
	});

	test("undefined agentConfig still resolves", () => {
		const r = resolveAgentInvocationConfig(undefined, {
			model: "from-params",
		});
		expect(r.modelInput).toBe("from-params");
		expect(r.modelFromParams).toBe(true);
	});
});

// ── thinking precedence ──────────────────────────────────────────────────────

describe("thinking precedence", () => {
	test("params.thinking wins", () => {
		const r = resolveAgentInvocationConfig(
			makeConfig({ thinking: "low" as AgentConfig["thinking"] }),
			{ thinking: "high" },
		);
		expect(r.thinking).toBe("high");
	});

	test("config.thinking used as default", () => {
		const r = resolveAgentInvocationConfig(
			makeConfig({ thinking: "medium" as AgentConfig["thinking"] }),
			{},
		);
		expect(r.thinking).toBe("medium");
	});

	test("defaults to medium when both absent", () => {
		const r = resolveAgentInvocationConfig(makeConfig(), {});
		expect(r.thinking).toBe("medium");
	});
});

// ── maxTurns precedence ──────────────────────────────────────────────────────

describe("maxTurns precedence", () => {
	test("params.turns wins over config.maxTurns", () => {
		const r = resolveAgentInvocationConfig(makeConfig({ maxTurns: 20 }), {
			turns: 5,
		});
		expect(r.maxTurns).toBe(5);
	});

	test("legacy params.max_turns wins over config.maxTurns", () => {
		const r = resolveAgentInvocationConfig(makeConfig({ maxTurns: 20 }), {
			max_turns: 3,
		});
		expect(r.maxTurns).toBe(3);
	});

	test("params.turns wins over params.max_turns (new key takes priority)", () => {
		const r = resolveAgentInvocationConfig(makeConfig(), {
			turns: 7,
			max_turns: 99,
		});
		expect(r.maxTurns).toBe(7);
	});

	test("config.maxTurns used as default", () => {
		const r = resolveAgentInvocationConfig(makeConfig({ maxTurns: 15 }), {});
		expect(r.maxTurns).toBe(15);
	});

	test("undefined when all absent", () => {
		const r = resolveAgentInvocationConfig(makeConfig(), {});
		expect(r.maxTurns).toBeUndefined();
	});
});

// ── inheritContext precedence ────────────────────────────────────────────────

describe("inheritContext precedence", () => {
	test("params.inherit_context wins", () => {
		const r = resolveAgentInvocationConfig(makeConfig({ inheritContext: false }), {
			inherit_context: true,
		});
		expect(r.inheritContext).toBe(true);
	});

	test("config.inheritContext used as default", () => {
		const r = resolveAgentInvocationConfig(makeConfig({ inheritContext: true }), {});
		expect(r.inheritContext).toBe(true);
	});

	test("defaults to false when both absent", () => {
		const r = resolveAgentInvocationConfig(makeConfig(), {});
		expect(r.inheritContext).toBe(false);
	});
});

// ── isolated precedence ──────────────────────────────────────────────────────

describe("isolated precedence", () => {
	test("params.isolated wins", () => {
		const r = resolveAgentInvocationConfig(makeConfig({ isolated: false }), {
			isolated: true,
		});
		expect(r.isolated).toBe(true);
	});

	test("config.isolated used as default", () => {
		const r = resolveAgentInvocationConfig(makeConfig({ isolated: true }), {});
		expect(r.isolated).toBe(true);
	});

	test("defaults to false when both absent", () => {
		const r = resolveAgentInvocationConfig(makeConfig(), {});
		expect(r.isolated).toBe(false);
	});
});

// ── all defaults at once ─────────────────────────────────────────────────────

describe("all defaults", () => {
	test("undefined config + empty params gives safe defaults", () => {
		const r = resolveAgentInvocationConfig(undefined, {});
		expect(r).toEqual({
			modelInput: undefined,
			modelFromParams: false,
			thinking: "medium",
			maxTurns: undefined,
			inheritContext: false,
			isolated: false,
		});
	});
});
