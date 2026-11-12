import { expect, test } from "bun:test";
import {
	BUILTIN_TOOL_NAMES,
	getAgentConfig,
	getAvailableTypes,
	getToolNamesForType,
	registerAgents,
} from "../src/agent-types.ts";
import { DEFAULT_AGENTS } from "../src/default-agents.ts";
import { resolveAgentInvocationConfig } from "../src/invocation-config.ts";
import type { AgentConfig } from "../src/types.ts";

test("BUILTIN_TOOL_NAMES is the 7 pi built-ins", () => {
	expect(new Set(BUILTIN_TOOL_NAMES)).toEqual(
		new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]),
	);
});

test("defaults register and Explore is read-only", () => {
	registerAgents(new Map());
	expect(getAvailableTypes()).toEqual(expect.arrayContaining(["general", "Explore", "Plan"]));
	// Explore omits write/edit/bash
	const explore = getToolNamesForType("Explore");
	expect(explore).not.toContain("write");
	expect(explore).not.toContain("edit");
});

test("getToolNamesForType falls back to all built-ins for unknown type", () => {
	registerAgents(new Map());
	expect(new Set(getToolNamesForType("does-not-exist"))).toEqual(new Set(BUILTIN_TOOL_NAMES));
});

test("no default agent carries a baked-in model", () => {
	// Type must imply tools + persona only — never a model. Caller picks model.
	for (const [_name, config] of DEFAULT_AGENTS) {
		expect(config.model).toBeUndefined();
	}
	// Sanity: built-ins are general, Explore, Plan, Mentor
	expect([...DEFAULT_AGENTS.keys()].sort()).toEqual(["Explore", "Mentor", "Plan", "general"]);
});

test("caller params.model always wins over agentConfig.model", () => {
	const customConfig: AgentConfig = {
		name: "test-custom",
		description: "test",
		extensions: true,
		skills: true,
		systemPrompt: "",
		promptMode: "append",
		model: "anthropic/claude-haiku-4-5-20251001",
	};

	// Caller passes sonnet → sonnet wins, not the haiku baked into the config
	const r1 = resolveAgentInvocationConfig(customConfig, {
		model: "anthropic/claude-sonnet-4-6",
	});
	expect(r1.modelInput).toBe("anthropic/claude-sonnet-4-6");
	expect(r1.modelFromParams).toBe(true);

	// Caller silent → config model applies as a default
	const r2 = resolveAgentInvocationConfig(customConfig, {});
	expect(r2.modelInput).toBe("anthropic/claude-haiku-4-5-20251001");
	expect(r2.modelFromParams).toBe(false);

	// Caller silent + no config model → undefined (caller inherits parent)
	const r3 = resolveAgentInvocationConfig({ ...customConfig, model: undefined }, {});
	expect(r3.modelInput).toBeUndefined();
	expect(r3.modelFromParams).toBe(false);
});

test("caller params.thinking always wins over agentConfig.thinking", () => {
	const customConfig: AgentConfig = {
		name: "test-thinking",
		description: "test",
		extensions: true,
		skills: true,
		systemPrompt: "",
		promptMode: "append",
		thinking: "low" as AgentConfig["thinking"],
	};

	// Caller passes high → high wins, not the low baked into the config
	const r1 = resolveAgentInvocationConfig(customConfig, { thinking: "high" });
	expect(r1.thinking).toBe("high");

	// Caller silent → config thinking applies as default
	const r2 = resolveAgentInvocationConfig(customConfig, {});
	expect(r2.thinking).toBe("low");
});

test("caller params.turns always wins over agentConfig.maxTurns", () => {
	const customConfig: AgentConfig = {
		name: "test-turns",
		description: "test",
		extensions: true,
		skills: true,
		systemPrompt: "",
		promptMode: "append",
		maxTurns: 10,
	};

	// Caller passes turns: 5 → 5 wins over config's 10
	const r1 = resolveAgentInvocationConfig(customConfig, { turns: 5 });
	expect(r1.maxTurns).toBe(5);

	// Legacy max_turns spelling also wins
	const r2 = resolveAgentInvocationConfig(customConfig, { max_turns: 3 });
	expect(r2.maxTurns).toBe(3);

	// Caller silent → config maxTurns applies as default
	const r3 = resolveAgentInvocationConfig(customConfig, {});
	expect(r3.maxTurns).toBe(10);
});

test("defaults resolve with no model — caller inherits parent", () => {
	registerAgents(new Map());
	for (const name of getAvailableTypes()) {
		const cfg = getAgentConfig(name);
		expect(cfg).toBeDefined();
		const r = resolveAgentInvocationConfig(cfg, {});
		expect(r.modelInput).toBeUndefined();
		expect(r.modelFromParams).toBe(false);
	}
});
