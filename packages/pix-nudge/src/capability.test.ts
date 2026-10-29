import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectDir } from "@xynogen/pix-runtime/paths";
import registerCapabilityNudge, {
	buildOrientation,
	CAPABILITY_REMINDER,
	capabilityReminder,
	countInvocableSkills,
	graphifyHint,
	partitionTools,
} from "./capability.ts";

// Minimal Skill-shaped fixtures (only fields the builder reads).
const skill = (name: string, description: string, disableModelInvocation = false) =>
	({
		name,
		description,
		disableModelInvocation,
		filePath: "",
		baseDir: "",
		sourceInfo: {} as never,
	}) as never;

// Minimal ToolInfo-shaped fixture.
const tool = (name: string, source: string) =>
	({
		name,
		description: `${name} desc.`,
		parameters: {},
		sourceInfo: { source, path: "", scope: "user", origin: "package" },
	}) as never;

describe("capabilityReminder", () => {
	test("unknown or empty registries use terse, conditional guidance", () => {
		expect(capabilityReminder(undefined)).toBe(CAPABILITY_REMINDER);
		expect(capabilityReminder(new Set())).toBe(CAPABILITY_REMINDER);
		expect(CAPABILITY_REMINDER).toMatch(
			/^Reminder — before you improvise, check available tools and relevant skills; ask the user only if needed\.$/,
		);
		expect(CAPABILITY_REMINDER.split(/\s+/).length).toBeLessThanOrEqual(28);
	});

	test("names only registered discovery tools", () => {
		expect(capabilityReminder(new Set(["read_skills", "tool_search", "mcp"]))).toMatch(
			/check available tools and relevant skills, read_skills\(\), tool_search, mcp; ask the user only if needed\.$/,
		);
		expect(capabilityReminder(new Set(["tool_search"]))).toMatch(
			/check available tools and relevant skills, tool_search; ask the user only if needed\.$/,
		);
	});
});

describe("countInvocableSkills", () => {
	test("zero for undefined / empty", () => {
		expect(countInvocableSkills(undefined)).toBe(0);
		expect(countInvocableSkills([])).toBe(0);
	});

	test("excludes user-only skills", () => {
		const n = countInvocableSkills([skill("a", "."), skill("b", ".", true), skill("c", ".")]);
		expect(n).toBe(2);
	});
});

describe("partitionTools", () => {
	test("splits MCP-sourced from other tools by source", () => {
		const { mcp, other } = partitionTools([
			tool("read", "builtin"),
			tool("context7-docs", "mcp:context7"),
			tool("notion-search", "MCP server notion"),
			tool("grep", "extension:pix-core"),
		]);
		expect(mcp).toBe(2);
		expect(other).toBe(2);
	});

	test("handles undefined", () => {
		expect(partitionTools(undefined)).toEqual({
			mcp: 0,
			other: 0,
			active: 0,
			gated: 0,
			mcpGated: 0,
			otherGated: 0,
		});
	});

	test("without an active set, every tool counts as active (gated 0)", () => {
		const { active, gated } = partitionTools([tool("read", "builtin"), tool("find", "builtin")]);
		expect(active).toBe(2);
		expect(gated).toBe(0);
	});

	test("with an active set, splits active vs gated", () => {
		const { active, gated } = partitionTools(
			[
				tool("read", "builtin"),
				tool("grep", "builtin"),
				tool("find", "builtin"),
				tool("ls", "builtin"),
			],
			["read", "grep"],
		);
		expect(active).toBe(2);
		expect(gated).toBe(2);
	});
	test("tracks deferred counts independently for each source", () => {
		const tools = [
			tool("read", "builtin"),
			tool("find", "builtin"),
			tool("docs", "mcp:docs"),
			tool("query", "mcp:db"),
		];
		expect(partitionTools(tools, ["read", "docs"])).toEqual({
			other: 2,
			mcp: 2,
			active: 2,
			gated: 2,
			otherGated: 1,
			mcpGated: 1,
		});
		expect(buildOrientation(tools, [], ["read", "docs"])).toMatch(
			/^Toolbelt: 2 tools \(1 deferred\), 2 MCP tools \(1 deferred\)\./,
		);
	});
});

describe("buildOrientation", () => {
	test("summarizes counts of tools, MCP tools, and skills", () => {
		const out = buildOrientation(
			[tool("read", "builtin"), tool("ctx", "mcp:context7")],
			[skill("commit", "Commit changes."), skill("plan", "Plan work.")],
		);
		expect(out).toContain("1 tool");
		expect(out).toContain("1 MCP tool");
		expect(out).toContain("2 skills");
	});

	test("maps only registered capabilities to their tools, without user-only toolbox", () => {
		const out = buildOrientation(
			[tool("read_skills", "x"), tool("ask_user", "x"), tool("lsp_navigation", "x")],
			[],
		);
		expect(out).toMatch(/^Before you improvise, use: ask_user .*read_skills\(\) .*lsp_\* .*\.$/m);
		expect(out).not.toContain("search/fetch");
		expect(out).not.toContain("/toolbox");
		expect(out).not.toContain("toolbox(");
	});

	test("web labels name only registered tools; wildcard labels are explicit families", () => {
		for (const name of ["search", "fetch"]) {
			const out = buildOrientation([tool(name, "x")], []);
			expect(out.split("\n")[1]).toBe(
				`Before you improvise, use: ${name} (${name === "search" ? "web" : "web pages"}).`,
			);
		}
		const out = buildOrientation([tool("context7-docs", "x"), tool("lsp_navigation", "x")], []);
		expect(out).toContain("context7 tool family (library docs)");
		expect(out).toContain("lsp_* tool family (types, refs, diagnostics)");
	});

	test("falls back to a generic line when no capability tool is registered", () => {
		const out = buildOrientation([tool("read", "builtin")], []);
		expect(out).toContain(
			"Before you improvise, check available tools and relevant skills; ask the user only if needed.",
		);
	});

	test("calls out gated tools and points at tool_search to load them", () => {
		const out = buildOrientation(
			[
				tool("read", "builtin"),
				tool("grep", "builtin"),
				tool("tool_search", "builtin"),
				tool("find", "builtin"),
				tool("ls", "builtin"),
			],
			[],
			["read", "grep", "tool_search"], // active set: 2 gated out
		);
		expect(out).toMatch(
			/2 are deferred \(.*\): load with tool_search\("<tool name or task>"\) before the first call\./,
		);
	});

	test("singular phrasing when exactly one tool is gated", () => {
		const out = buildOrientation(
			[tool("read", "builtin"), tool("tool_search", "builtin"), tool("find", "builtin")],
			[],
			["read", "tool_search"],
		);
		expect(out).toMatch(/1 is deferred \(.*\): load with tool_search/);
	});

	test("no tool_search registered: never tells the model to call it", () => {
		const out = buildOrientation([tool("read", "builtin"), tool("find", "builtin")], [], ["read"]);
		expect(out).toMatch(/^Toolbelt: 2 tools \(1 deferred\)\.$/m);
		expect(out).not.toContain("tool_search");
	});

	test("no gate line when nothing is gated", () => {
		const out = buildOrientation(
			[tool("read", "builtin"), tool("grep", "builtin")],
			[],
			["read", "grep"],
		);
		expect(out).not.toContain("deferred");
	});

	test("no gate line when active set is unknown", () => {
		const out = buildOrientation([tool("read", "builtin"), tool("find", "builtin")], []);
		expect(out).not.toContain("deferred");
	});

	test("lists invocable skill names, sorted, excluding user-only", () => {
		const out = buildOrientation(
			[],
			[skill("zebra", "z."), skill("alpha", "a."), skill("hidden", "h.", true)],
		);
		expect(out).toContain("Skills: alpha, zebra.");
		expect(out).not.toContain("hidden");
	});

	test("omits the skills line when no invocable skills", () => {
		const out = buildOrientation([tool("read", "builtin")], [skill("x", ".", true)]);
		expect(out).not.toContain("Skills:");
	});

	test("steers away from improvising", () => {
		const out = buildOrientation([tool("read", "builtin")], []);
		expect(out.toLowerCase()).toContain("improvis");
	});

	test("unknown registry does not advertise a graph tool", () => {
		expect(buildOrientation(undefined, [])).not.toContain('graph(action:"query"');
	});

	test("frames the block as non-actionable so the model acts on the prompt", () => {
		const out = buildOrientation([tool("read", "builtin")], []);
		const last = out.trim().split("\n").at(-1) ?? "";
		expect(last.toLowerCase()).toContain("not a task");
		expect(last.toLowerCase()).toContain("do not reply");
	});
});

describe("registerCapabilityNudge", () => {
	test("sends orientation as a visible message and leaves the system prompt alone", async () => {
		let handler: ((event: { systemPrompt?: string; messageType?: string }) => unknown) | undefined;
		const pi = {
			on(event: string, fn: typeof handler) {
				if (event === "before_agent_start") handler = fn;
			},
			getAllTools() {
				return [
					tool("read", "builtin"),
					tool("ask_user", "builtin"),
					tool("tool_search", "builtin"),
					tool("context7-docs", "mcp:context7"),
					tool("notion-search", "MCP server notion"),
				];
			},
			getActiveTools() {
				return ["read"];
			},
		} as never;

		registerCapabilityNudge(pi);
		expect(await handler?.({ systemPrompt: "BASE", messageType: "custom" })).toBeUndefined();
		const result = (await handler?.({ systemPrompt: "BASE" })) as {
			systemPrompt?: string;
			message: { customType: string; content: string; display: boolean; details: unknown };
		};

		expect(result.systemPrompt).toBeUndefined();
		expect(result.message).toEqual({
			customType: "pix-capability-nudge",
			content: expect.stringMatching(/^Toolbelt:[\s\S]*Orientation only/),
			display: true,
			details: {
				kind: "orientation",
				summary: "3 tools (2 deferred) · 2 MCP tools (2 deferred) · 2 capabilities",
			},
		});
		expect(await handler?.({ systemPrompt: "BASE" })).toBeUndefined(); // turn 2: nothing
	});
});

describe("graphifyHint", () => {
	const tmpDir = join(import.meta.dir, ".graphify-hint-test-tmp");

	test("returns undefined when no graph.json present", () => {
		expect(graphifyHint(tmpDir)).toBeUndefined();
	});

	test("returns hint for the graph output dir (.pi/graph)", () => {
		try {
			mkdirSync(join(projectDir(tmpDir), "graph"), { recursive: true });
			writeFileSync(join(tmpDir, ".pi/graph", "graph.json"), "{}");
			const hint = graphifyHint(tmpDir);
			expect(hint).toBeTypeOf("string");
			expect(hint).toContain(".pi/graph/graph.json");
			expect(hint).toContain('graph(action:"query"');
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("still detects the legacy graphify-out dir", () => {
		try {
			mkdirSync(join(tmpDir, "graphify-out"), { recursive: true });
			writeFileSync(join(tmpDir, "graphify-out", "graph.json"), "{}");
			expect(graphifyHint(tmpDir)).toContain("graphify-out/graph.json");
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
