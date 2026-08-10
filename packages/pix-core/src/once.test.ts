import { afterEach, describe, expect, it } from "bun:test";
import registerCommands from "@xynogen/pix-commands/src/extension.ts";
import registerSubagent from "@xynogen/pix-subagent/src/extension.ts";
import registerTodo from "@xynogen/pix-todo/src/todo.ts";

// Mirror of the per-instance guard. pix-core does not own once.ts (each member
// duplicates it to stay cross-dep-free), so we re-declare the contract here and
// assert the dedupe semantics that the aggregator relies on.
function once(pi: object, key: string, fn: () => void): void {
	const g = globalThis as { __pixOnce?: WeakMap<object, Set<string>> };
	if (!g.__pixOnce) g.__pixOnce = new WeakMap<object, Set<string>>();
	const registry = g.__pixOnce;
	let loaded = registry.get(pi);
	if (!loaded) {
		loaded = new Set<string>();
		registry.set(pi, loaded);
	}
	if (loaded.has(key)) return;
	loaded.add(key);
	fn();
}

afterEach(() => {
	delete (globalThis as { __pixOnce?: WeakMap<object, Set<string>> }).__pixOnce;
});

describe("once", () => {
	it("runs the factory on first invocation", () => {
		const pi = {};
		let calls = 0;
		once(pi, "pix-footer", () => {
			calls++;
		});
		expect(calls).toBe(1);
	});

	it("skips repeated invocations of the same key on the same pi", () => {
		const pi = {};
		let calls = 0;
		const reg = () => {
			calls++;
		};
		once(pi, "pix-footer", reg);
		once(pi, "pix-footer", reg);
		once(pi, "pix-footer", reg);
		expect(calls).toBe(1);
	});

	it("isolates distinct keys on the same pi", () => {
		const pi = {};
		const seen: string[] = [];
		once(pi, "pix-footer", () => seen.push("footer"));
		once(pi, "pix-welcome", () => seen.push("welcome"));
		expect(seen).toEqual(["footer", "welcome"]);
	});

	it("shares the registry across calls via globalThis (same pi)", () => {
		const pi = {};
		let calls = 0;
		once(pi, "pix-skills", () => {
			calls++;
		});
		// A second loader pass (e.g. standalone install after pix-core) reuses
		// the same globalThis registry for the same pi and must not re-run.
		once(pi, "pix-skills", () => {
			calls++;
		});
		expect(calls).toBe(1);
	});

	it("re-runs for a new pi instance with the same key (/new rehydration)", () => {
		const pi1 = {};
		const pi2 = {};
		let calls = 0;
		once(pi1, "pix-footer", () => {
			calls++;
		});
		// pi2 is a fresh instance (as built by Pi on /new, /resume, /fork, /reload).
		// The factory must run again — this is the rehydration guarantee.
		once(pi2, "pix-footer", () => {
			calls++;
		});
		expect(calls).toBe(2);
	});

	it("same key on two different pi instances dedupes within each instance", () => {
		const pi1 = {};
		const pi2 = {};
		let calls1 = 0;
		let calls2 = 0;
		once(pi1, "pix-welcome", () => {
			calls1++;
		});
		once(pi1, "pix-welcome", () => {
			calls1++;
		}); // second on pi1 → skip
		once(pi2, "pix-welcome", () => {
			calls2++;
		});
		once(pi2, "pix-welcome", () => {
			calls2++;
		}); // second on pi2 → skip
		expect(calls1).toBe(1); // deduped within pi1
		expect(calls2).toBe(1); // deduped within pi2
	});
});

// Behavior pin: prove a REAL guarded member dedupes when its factory runs
// twice against the SAME pi — the exact scenario the aggregator creates when a
// tool is installed both via pix-core (this boots it) and standalone (Pi boots
// it again). The member must register its tool only once or Pi reports a
// tool conflict.
describe("member factory dedupe (pix-todo)", () => {
	function makeHost() {
		const toolNames: string[] = [];
		const pi = {
			registerTool(def: { name: string }) {
				toolNames.push(def.name);
			},
			appendEntry() {},
			on() {},
		} as never;
		return { pi, toolNames };
	}

	it("registers the tool once across core + standalone activation (same pi)", () => {
		const { pi, toolNames } = makeHost();
		// First pass: pix-core's aggregator invokes the member factory.
		registerTodo(pi);
		// Second pass: standalone install loads the same module and invokes it
		// again. The globalThis once() registry must suppress re-registration.
		registerTodo(pi);
		expect(toolNames).toEqual(["todo"]);
	});

	it("registers the tool again for a fresh pi instance (/new rehydration)", () => {
		const { pi: pi1, toolNames: tools1 } = makeHost();
		const { pi: pi2, toolNames: tools2 } = makeHost();
		// First session.
		registerTodo(pi1);
		// /new: a fresh pi is built; factory must run again.
		registerTodo(pi2);
		expect(tools1).toEqual(["todo"]);
		expect(tools2).toEqual(["todo"]);
	});
});

describe("member factory dedupe (pix-commands)", () => {
	function makeHost() {
		const commandNames: string[] = [];
		const pi = {
			registerCommand(name: string) {
				commandNames.push(name);
			},
			registerEntryRenderer() {},
			on() {},
		} as never;
		return { pi, commandNames };
	}

	it("registers /clear, /btw, and /afk once across core + standalone activation", () => {
		const { pi, commandNames } = makeHost();
		registerCommands(pi);
		registerCommands(pi);
		expect(commandNames).toEqual(["clear", "btw", "afk"]);
	});

	it("registers commands again for a fresh pi instance", () => {
		const first = makeHost();
		const second = makeHost();
		registerCommands(first.pi);
		registerCommands(second.pi);
		expect(first.commandNames).toEqual(["clear", "btw", "afk"]);
		expect(second.commandNames).toEqual(["clear", "btw", "afk"]);
	});
});

describe("member factory dedupe (pix-subagent)", () => {
	function makeHost() {
		const toolNames: string[] = [];
		const pi = {
			registerTool(def: { name: string }) {
				toolNames.push(def.name);
			},
			appendEntry() {},
			on() {},
			getAvailableAgentTypes() {
				return [];
			},
			getAvailableModels() {
				return [];
			},
			registerMessageRenderer() {},
		} as never;
		return { pi, toolNames };
	}

	it("registers agent tools once across core + standalone activation (same pi)", () => {
		const { pi, toolNames } = makeHost();
		registerSubagent(pi);
		registerSubagent(pi);
		expect(toolNames).toEqual(["agent_info", "agent", "agent_result", "agent_steer"]);
	});

	it("registers agent tools again for a fresh pi instance (/new rehydration)", () => {
		const { pi: pi1, toolNames: tools1 } = makeHost();
		const { pi: pi2, toolNames: tools2 } = makeHost();
		registerSubagent(pi1);
		registerSubagent(pi2);
		expect(tools1).toEqual(["agent_info", "agent", "agent_result", "agent_steer"]);
		expect(tools2).toEqual(["agent_info", "agent", "agent_result", "agent_steer"]);
	});
});
