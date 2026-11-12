import { afterEach, describe, expect, test } from "bun:test";
import registerPixSubagent from "../src/index.ts";

const CLEANUP_KEY = "__pix-subagentCleanup";

type CleanupMap = WeakMap<object, () => void>;
const cleanupMap = () => (globalThis as Record<string, unknown>)[CLEANUP_KEY] as CleanupMap;

const hosts: object[] = [];
afterEach(() => {
	const map = cleanupMap();
	for (const h of hosts) map?.get(h)?.();
	hosts.length = 0;
});

interface ToolDef {
	name: string;
	execute: (id: string, params: Record<string, unknown>, ...rest: unknown[]) => Promise<unknown>;
}

function host() {
	const tools = new Map<string, ToolDef>();
	const h = {
		tools,
		registerTool(def: ToolDef) {
			tools.set(def.name, def);
		},
		registerMessageRenderer() {},
		on() {},
		getAvailableAgentTypes() {
			return [];
		},
		getAvailableModels() {
			return [];
		},
	};
	hosts.push(h);
	return h;
}

async function listActive(h: ReturnType<typeof host>): Promise<string> {
	const ctl = h.tools.get("agent_control");
	if (!ctl) throw new Error("agent_control not registered");
	const res = (await ctl.execute(
		"call",
		{ action: "info", kind: "active" },
		new AbortController().signal,
		undefined,
		{} as never,
	)) as { content: Array<{ text: string }> };
	return res.content[0]?.text ?? "";
}

describe("pix-subagent reload cleanup", () => {
	test("re-registering on the SAME host runs the previous cleanup and replaces it", () => {
		const h = host();
		registerPixSubagent(h as never);
		const first = cleanupMap().get(h);
		if (!first) throw new Error("reload cleanup not registered");

		registerPixSubagent(h as never);
		const second = cleanupMap().get(h);
		expect(typeof second).toBe("function");
		expect(second).not.toBe(first);
		// Stale one is idempotent.
		expect(() => first()).not.toThrow();
	});

	test("registering on a DIFFERENT host (child subagent session) does not dispose the parent's manager", async () => {
		// Regression: the cleanup slot used to be a single globalThis function, so
		// a child session loading this extension (fresh `pi`) wiped the parent's
		// agent map — agent_control then reported "(none)" / "Agent not found".
		const parent = host();
		registerPixSubagent(parent as never);
		const parentCleanup = cleanupMap().get(parent);

		const child = host();
		registerPixSubagent(child as never);

		// Parent's cleanup untouched; parent tools still answer.
		expect(cleanupMap().get(parent)).toBe(parentCleanup);
		expect(cleanupMap().get(child)).not.toBe(parentCleanup);
		await expect(listActive(parent)).resolves.toContain("Agents:");
	});
});
