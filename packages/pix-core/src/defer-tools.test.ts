import { expect, test } from "bun:test";
import deferNonCoreTools from "./defer-tools.ts";

test("keeps Windows PowerShell direct, defers other non-core tools, and activates loaders", () => {
	const registered: Array<{ name: string; exposure?: string }> = [];
	const handlers: Array<() => void> = [];
	let active = ["read", "bash"];
	const pi = {
		registerTool: (tool: { name: string; exposure?: string }) => registered.push(tool),
		on: (_ev: string, fn: () => void) => handlers.push(fn),
		getActiveTools: () => active,
		getAllTools: () => [{ name: "tool_search" }, { name: "codemode" }],
		setActiveTools: (names: string[]) => {
			active = names;
		},
	};
	deferNonCoreTools(pi as never);
	pi.registerTool({ name: "read" });
	pi.registerTool({ name: "grep" });
	pi.registerTool({ name: "ls" });
	pi.registerTool({ name: "ask_user", exposure: "direct" });
	pi.registerTool({ name: "powershell" });
	pi.registerTool({ name: "voice", exposure: "codemode" });
	expect(registered.map((t) => `${t.name}:${t.exposure ?? "direct"}`)).toEqual([
		"read:direct",
		"grep:deferred",
		"ls:deferred",
		"ask_user:deferred",
		"powershell:direct",
		"voice:codemode",
	]);
	for (const fn of handlers) fn();
	expect(active).toEqual(["read", "bash", "tool_search", "codemode"]);
});
