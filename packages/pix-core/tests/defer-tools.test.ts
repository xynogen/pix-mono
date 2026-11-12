import { expect, test } from "bun:test";
import deferNonCoreTools, { weightNative } from "../src/defer-tools.ts";

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
	expect(onResult).toHaveLength(2); // tool_search pool widening + re-rank
});

const info = (name: string, source = "pkg") => ({ name, sourceInfo: { source } }) as never;
const mcp = (server: string, n: number) =>
	Array.from({ length: n }, (_, i) => `mcp__${server}__t${i}`);
// BM25 order for "search file contents": 9 KiCad/Playwright hits, then the native tools.
const ranked = [...mcp("kicad", 6), "grep", ...mcp("playwright", 3), "ast_search"];
const tools = ranked.map((n) => info(n, n.startsWith("mcp__") ? `mcp:${n.split("__")[1]}` : "pkg"));

test("weightNative lifts native tools and drops unnamed MCP hits ranked below them", () => {
	// grep (rank 6) beats every penalised hit. Playwright (7-9) ranked below grep: dropped.
	// ast_search (10) ties with kicad t2 (2 + 8); the tie keeps BM25 order.
	expect(weightNative(ranked, tools, "search file contents")).toEqual([
		"grep",
		"mcp__kicad__t0",
		"mcp__kicad__t1",
		"mcp__kicad__t2",
		"ast_search",
		"mcp__kicad__t3",
		"mcp__kicad__t4",
		"mcp__kicad__t5",
	]);
});

test("weightNative keeps every MCP hit when the pool has no native tool", () => {
	const onlyMcp = mcp("kicad", 3);
	expect(weightNative(onlyMcp, tools, "footprint")).toEqual(onlyMcp);
});

test("weightNative keeps the order of tools from a server the query names", () => {
	const kicad = weightNative(ranked, tools, "kicad search");
	expect(kicad.slice(0, 7)).toEqual([...mcp("kicad", 6), "grep"]);
});

test("tool_search asks for a wider pool, keeps the re-ranked top, unloads the rest", () => {
	let active = ["read", ...ranked];
	const handlers = new Map<string, (e: unknown) => unknown>();
	const pi = {
		registerTool: () => {},
		on: (ev: string, fn: (e: unknown) => unknown) => handlers.set(ev, fn),
		getActiveTools: () => active,
		getAllTools: () => tools,
		setActiveTools: (names: string[]) => {
			active = names;
		},
	};
	deferNonCoreTools(pi as never);
	const input: Record<string, unknown> = { query: "search file contents", limit: 3 };
	handlers.get("tool_call")?.({ toolName: "tool_search", toolCallId: "c1", input });
	expect(input.limit).toBe(9);

	const text = [
		"Loaded 11 tools. They are available from your next call:",
		...ranked.map((n) => `- ${n}: d`),
	];
	const out = handlers.get("tool_result")?.({
		toolName: "tool_search",
		toolCallId: "c1",
		isError: false,
		input,
		content: [{ type: "text", text: text.join("\n") }],
		details: { loaded: ranked },
	}) as { content: { text: string }[]; details: { loaded: string[] } };
	expect(active).toEqual(["read", "mcp__kicad__t0", "mcp__kicad__t1", "grep"]);
	expect(out.details.loaded).toEqual(["grep", "mcp__kicad__t0", "mcp__kicad__t1"]);
	expect(out.content[0]?.text).toMatch(
		/^Loaded 3 tools\.[^\n]*\n- grep: d\n- mcp__kicad__t0: d\n- mcp__kicad__t1: d\nRanked below native tools: mcp__kicad__t2\. Name the server in the query to load them\.$/,
	);
});
