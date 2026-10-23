import { expect, test } from "bun:test";
import deferNonCoreTools from "./defer-tools.ts";

test("defers non-core direct tools and activates tool_search", async () => {
	const registered: Array<{ name: string; exposure?: string }> = [];
	const handlers: Array<() => void> = [];
	let active = ["read", "bash"];
	const pi = {
		registerTool: (tool: { name: string; exposure?: string }) => registered.push(tool),
		on: (_ev: string, fn: () => void) => handlers.push(fn),
		getActiveTools: () => active,
		getAllTools: () => [{ name: "tool_search" }],
		setActiveTools: (names: string[]) => {
			active = names;
		},
	};
	deferNonCoreTools(pi as never);
	pi.registerTool({ name: "read" });
	pi.registerTool({ name: "grep" });
	pi.registerTool({ name: "ls" });
	pi.registerTool({ name: "ask_user", exposure: "direct" });
	pi.registerTool({ name: "voice", exposure: "codemode" });
	expect(registered.map((t) => `${t.name}:${t.exposure ?? "direct"}`)).toEqual([
		"read:direct",
		"grep:direct",
		"ls:deferred",
		"ask_user:deferred",
		"voice:codemode",
	]);
	for (const fn of handlers) fn();
	expect(active).toEqual(["read", "bash", "tool_search"]);
});
