import { expect, test } from "bun:test";
import deferNonCoreTools, { demotedMcp } from "./defer-tools.ts";

test("keeps Windows PowerShell direct, defers other non-core tools, and activates loaders", () => {
	const registered: Array<{ name: string; exposure?: string }> = [];
	const handlers: Array<() => void> = [];
	const onResult: Array<(e: unknown) => unknown> = [];
	let active = ["read", "bash"];
	const pi = {
		registerTool: (tool: { name: string; exposure?: string }) => registered.push(tool),
		on: (ev: string, fn: () => void) =>
			ev === "session_start" ? handlers.push(fn) : onResult.push(fn as (e: unknown) => unknown),
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
	expect(onResult).toHaveLength(1);
});

const info = (name: string, source = "pkg") => ({ name, sourceInfo: { source } }) as never;
const tools = [
	info("mcp__kicad__list_libs", "mcp:kicad"),
	info("grep"),
	info("mcp__playwright__browser_find", "mcp:playwright"),
	info("ast_search"),
	info("mcp__kicad__save_project", "mcp:kicad"),
];
const loaded = [
	"mcp__kicad__list_libs",
	"grep",
	"mcp__playwright__browser_find",
	"ast_search",
	"mcp__kicad__save_project",
];

test("demotedMcp drops MCP hits ranked below the first native hit", () => {
	expect(demotedMcp(loaded, tools, "search file contents")).toEqual([
		"mcp__playwright__browser_find",
		"mcp__kicad__save_project",
	]);
});

test("demotedMcp keeps MCP tools whose server the query names, or with no native hit", () => {
	expect(demotedMcp(loaded, tools, "kicad search")).toEqual(["mcp__playwright__browser_find"]);
	expect(demotedMcp(["mcp__kicad__list_libs"], tools, "libs")).toEqual([]);
});

test("tool_search result unloads demoted MCP tools and says so", () => {
	let active = ["read", ...loaded];
	const results: Array<(e: unknown) => unknown> = [];
	const pi = {
		registerTool: () => {},
		on: (ev: string, fn: (e: unknown) => unknown) => ev === "tool_result" && results.push(fn),
		getActiveTools: () => active,
		getAllTools: () => tools,
		setActiveTools: (names: string[]) => {
			active = names;
		},
	};
	deferNonCoreTools(pi as never);
	const text = [
		"Loaded 5 tools. They are available from your next call:",
		...loaded.map((n) => `- ${n}: d`),
	];
	const out = results[0]?.({
		toolName: "tool_search",
		isError: false,
		input: { query: "search file contents" },
		content: [{ type: "text", text: text.join("\n") }],
		details: { loaded },
	}) as { content: { text: string }[]; details: { loaded: string[] } };
	expect(active).toEqual(["read", "mcp__kicad__list_libs", "grep", "ast_search"]);
	expect(out.details.loaded).toEqual(["mcp__kicad__list_libs", "grep", "ast_search"]);
	expect(out.content[0]?.text).toMatch(
		/^Loaded 3 tools\.[^\n]*\n- mcp__kicad__list_libs: d\n- grep: d\n- ast_search: d\nSkipped 2 MCP tool\(s\) ranked below native matches: mcp__playwright__browser_find, mcp__kicad__save_project\. Name the server in the query to load them\.$/,
	);
});
