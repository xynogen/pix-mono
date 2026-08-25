import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import registerCapabilityNudge, {
	buildOrientation,
	CAPABILITY_REMINDER,
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

describe("CAPABILITY_REMINDER", () => {
	test("is terse — fires every turn, must stay cheap", () => {
		expect(CAPABILITY_REMINDER.split(/\s+/).length).toBeLessThanOrEqual(28);
	});

	test("names the core capability surfaces", () => {
		for (const cap of ["skill", "tool", "MCP", "web", "user"]) {
			expect(CAPABILITY_REMINDER).toContain(cap);
		}
	});

	test("steers away from improvising", () => {
		expect(CAPABILITY_REMINDER.toLowerCase()).toContain("improvis");
	});

	test("nudges model to call read_skills() when a skill matches", () => {
		expect(CAPABILITY_REMINDER).toContain("read_skills()");
	});

	test("does not mention user-only toolbox command", () => {
		expect(CAPABILITY_REMINDER).not.toContain("/toolbox");
		expect(CAPABILITY_REMINDER).not.toContain("toolbox(");
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

	test("explains how to use read_skills() without user-only toolbox", () => {
		const out = buildOrientation([tool("read", "builtin")], []);
		expect(out).toContain("read_skills()");
		expect(out).not.toContain("/toolbox");
		expect(out).not.toContain("toolbox(");
	});

	test("calls out gated tools and points at toolbox to enable them", () => {
		const out = buildOrientation(
			[
				tool("read", "builtin"),
				tool("grep", "builtin"),
				tool("find", "builtin"),
				tool("ls", "builtin"),
			],
			[],
			["read", "grep"], // active set: 2 gated out
		);
		expect(out).toContain("2 are gated");
		expect(out).toContain("function definitions");
	});

	test("singular phrasing when exactly one tool is gated", () => {
		const out = buildOrientation([tool("read", "builtin"), tool("find", "builtin")], [], ["read"]);
		expect(out).toContain("1 is gated");
		expect(out).toContain("function definitions");
	});

	test("no gate line when nothing is gated", () => {
		const out = buildOrientation(
			[tool("read", "builtin"), tool("grep", "builtin")],
			[],
			["read", "grep"],
		);
		expect(out).not.toContain("gated out of the prompt");
	});

	test("no gate line when active set is unknown", () => {
		const out = buildOrientation([tool("read", "builtin"), tool("find", "builtin")], []);
		expect(out).not.toContain("gated out of the prompt");
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

	test("frames the block as non-actionable so the model acts on the prompt", () => {
		const out = buildOrientation([tool("read", "builtin")], []);
		const last = out.trim().split("\n").at(-1) ?? "";
		expect(last.toLowerCase()).toContain("not a task");
		expect(last.toLowerCase()).toContain("do not reply");
	});
});

describe("registerCapabilityNudge", () => {
	test("injects orientation into system prompt, not a custom message", async () => {
		let handler: ((event: { systemPrompt?: string }) => unknown) | undefined;
		const pi = {
			on(event: string, fn: typeof handler) {
				if (event === "before_agent_start") handler = fn;
			},
			getAllTools() {
				return [tool("read", "builtin")];
			},
			getActiveTools() {
				return ["read"];
			},
		} as never;

		registerCapabilityNudge(pi);
		const result = (await handler?.({ systemPrompt: "BASE" })) as {
			systemPrompt?: string;
			message?: unknown;
		};

		expect(result.message).toBeUndefined();
		expect(result.systemPrompt).toStartWith("BASE\n\nToolbelt:");
		expect(result.systemPrompt).toContain("Orientation only");
	});
});

describe("graphifyHint", () => {
	const tmpDir = join(import.meta.dir, ".graphify-hint-test-tmp");

	test("returns undefined when no graph.json present", () => {
		expect(graphifyHint(tmpDir)).toBeUndefined();
	});

	test("returns hint for the pix-graph output dir (.pi/pix-graph)", () => {
		try {
			mkdirSync(join(tmpDir, ".pi/pix-graph"), { recursive: true });
			writeFileSync(join(tmpDir, ".pi/pix-graph", "graph.json"), "{}");
			const hint = graphifyHint(tmpDir);
			expect(hint).toBeTypeOf("string");
			expect(hint).toContain(".pi/pix-graph/graph.json");
			expect(hint).toContain('graph(mode:"query"');
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
