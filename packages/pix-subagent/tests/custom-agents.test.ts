import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectDir, tempDir } from "@xynogen/pix-runtime/paths";
import { loadCustomAgents } from "../src/custom-agents.ts";
import type { AgentConfig } from "../src/types.ts";

// ── env isolation ─────────────────────────────────────────────────────────────
// loadCustomAgents() scans the global dir ($PI_CODING_AGENT_DIR/agents/) in
// addition to the project dir. Without isolation, any .md files a developer
// has in ~/.pi/agent/agents/ bleed into tests that assert on agents.size or
// specific absence of agents — making the suite flaky across environments.
// Point the env var at an empty temp dir for every test so the global scan
// is deterministic.
let savedEnvAgentDir: string | undefined;
let emptyGlobalDir: string;

beforeEach(() => {
	savedEnvAgentDir = process.env.PI_CODING_AGENT_DIR;
	emptyGlobalDir = mkdtempSync(join(tempDir(), "pixsa-global-"));
	process.env.PI_CODING_AGENT_DIR = emptyGlobalDir;
});

afterEach(() => {
	if (savedEnvAgentDir !== undefined) {
		process.env.PI_CODING_AGENT_DIR = savedEnvAgentDir;
	} else {
		delete process.env.PI_CODING_AGENT_DIR;
	}
});

test("loads a project .pi/agents/*.md with frontmatter", () => {
	const cwd = mkdtempSync(join(tempDir(), "pixsa-"));
	mkdirSync(join(projectDir(cwd), "agents"), { recursive: true });
	writeFileSync(
		join(projectDir(cwd), "agents", "scout.md"),
		"---\ndescription: scout the code\ntools: read, grep, find\nmodel: haiku\n---\nYou are a scout.",
	);
	const agents = loadCustomAgents(cwd);
	const scout = agents.get("scout");
	expect(scout?.description).toBe("scout the code");
	expect(new Set(scout?.builtinToolNames)).toEqual(new Set(["read", "grep", "find"]));
	expect(scout?.model).toBe("haiku");
	expect(scout?.systemPrompt).toBe("You are a scout.");
});

// ── thinking level validation ────────────────────────────────────────────────

describe("thinking level validation", () => {
	test("valid thinking levels are accepted", () => {
		for (const level of ["off", "minimal", "low", "medium", "high", "xhigh"]) {
			const cwd = mkdtempSync(join(tempDir(), "pixsa-"));
			mkdirSync(join(projectDir(cwd), "agents"), { recursive: true });
			writeFileSync(
				join(projectDir(cwd), "agents", "a.md"),
				`---\nthinking: ${level}\n---\nprompt`,
			);
			const agents = loadCustomAgents(cwd);
			const a = agents.get("a");
			expect(a?.thinking).toBe(level as AgentConfig["thinking"]);
			expect(a?.warnings).toBeUndefined();
		}
	});

	test("invalid thinking level → undefined + warning populated", () => {
		const cwd = mkdtempSync(join(tempDir(), "pixsa-"));
		mkdirSync(join(projectDir(cwd), "agents"), { recursive: true });
		writeFileSync(join(projectDir(cwd), "agents", "bad.md"), "---\nthinking: hgih\n---\nprompt");
		const agents = loadCustomAgents(cwd);
		const bad = agents.get("bad");
		expect(bad?.thinking).toBeUndefined();
		expect(bad?.warnings).toBeDefined();
		expect(bad?.warnings?.length).toBe(1);
		expect(bad?.warnings?.[0]).toContain('thinking: "hgih"');
		expect(bad?.warnings?.[0]).toContain("not a valid level");
	});

	test("omitted thinking → undefined, no warning", () => {
		const cwd = mkdtempSync(join(tempDir(), "pixsa-"));
		mkdirSync(join(projectDir(cwd), "agents"), { recursive: true });
		writeFileSync(
			join(projectDir(cwd), "agents", "plain.md"),
			"---\ndescription: no thinking\n---\nprompt",
		);
		const agents = loadCustomAgents(cwd);
		const plain = agents.get("plain");
		expect(plain?.thinking).toBeUndefined();
		expect(plain?.warnings).toBeUndefined();
	});
});

// ── run_in_background frontmatter ───────────────────────────────────────────

describe("run_in_background is no longer a config field", () => {
	test("run_in_background frontmatter does NOT set runInBackground on config", () => {
		const cwd = mkdtempSync(join(tempDir(), "pixsa-"));
		mkdirSync(join(projectDir(cwd), "agents"), { recursive: true });
		writeFileSync(
			join(projectDir(cwd), "agents", "bg.md"),
			"---\ndescription: tries to set bg\nrun_in_background: true\n---\nprompt",
		);
		const agents = loadCustomAgents(cwd);
		const bg = agents.get("bg");
		if (!bg) throw new Error("expected 'bg' agent to exist");
		// The field should NOT exist on the returned config
		expect("runInBackground" in bg).toBe(false);
	});

	test("run_in_background: false frontmatter also does NOT set runInBackground", () => {
		const cwd = mkdtempSync(join(tempDir(), "pixsa-"));
		mkdirSync(join(projectDir(cwd), "agents"), { recursive: true });
		writeFileSync(
			join(projectDir(cwd), "agents", "fg.md"),
			"---\ndescription: tries fg\nrun_in_background: false\n---\nprompt",
		);
		const agents = loadCustomAgents(cwd);
		const fg = agents.get("fg");
		if (!fg) throw new Error("expected 'fg' agent to exist");
		expect("runInBackground" in fg).toBe(false);
	});
});

// ── additional frontmatter fields ───────────────────────────────────────────

describe("additional frontmatter parsing", () => {
	test("max_turns is parsed as number", () => {
		const cwd = mkdtempSync(join(tempDir(), "pixsa-"));
		mkdirSync(join(projectDir(cwd), "agents"), { recursive: true });
		writeFileSync(join(projectDir(cwd), "agents", "limited.md"), "---\nmax_turns: 15\n---\nprompt");
		const agents = loadCustomAgents(cwd);
		expect(agents.get("limited")?.maxTurns).toBe(15);
	});

	test("extensions: false disables extensions", () => {
		const cwd = mkdtempSync(join(tempDir(), "pixsa-"));
		mkdirSync(join(projectDir(cwd), "agents"), { recursive: true });
		writeFileSync(
			join(projectDir(cwd), "agents", "noext.md"),
			"---\nextensions: false\n---\nprompt",
		);
		const agents = loadCustomAgents(cwd);
		expect(agents.get("noext")?.extensions).toBe(false);
	});

	test("extensions: CSV list parsed correctly", () => {
		const cwd = mkdtempSync(join(tempDir(), "pixsa-"));
		mkdirSync(join(projectDir(cwd), "agents"), { recursive: true });
		writeFileSync(
			join(projectDir(cwd), "agents", "selext.md"),
			"---\nextensions: mcp, lsp\n---\nprompt",
		);
		const agents = loadCustomAgents(cwd);
		expect(agents.get("selext")?.extensions).toEqual(["mcp", "lsp"]);
	});

	test("isolated: true is parsed", () => {
		const cwd = mkdtempSync(join(tempDir(), "pixsa-"));
		mkdirSync(join(projectDir(cwd), "agents"), { recursive: true });
		writeFileSync(join(projectDir(cwd), "agents", "iso.md"), "---\nisolated: true\n---\nprompt");
		const agents = loadCustomAgents(cwd);
		expect(agents.get("iso")?.isolated).toBe(true);
	});

	test("inherit_context: true is parsed", () => {
		const cwd = mkdtempSync(join(tempDir(), "pixsa-"));
		mkdirSync(join(projectDir(cwd), "agents"), { recursive: true });
		writeFileSync(
			join(projectDir(cwd), "agents", "ctx.md"),
			"---\ninherit_context: true\n---\nprompt",
		);
		const agents = loadCustomAgents(cwd);
		expect(agents.get("ctx")?.inheritContext).toBe(true);
	});

	test("prompt_mode: append is parsed (default is replace)", () => {
		const cwd = mkdtempSync(join(tempDir(), "pixsa-"));
		mkdirSync(join(projectDir(cwd), "agents"), { recursive: true });
		writeFileSync(
			join(projectDir(cwd), "agents", "app.md"),
			"---\nprompt_mode: append\n---\nprompt",
		);
		writeFileSync(
			join(projectDir(cwd), "agents", "rep.md"),
			"---\nprompt_mode: replace\n---\nprompt",
		);
		writeFileSync(
			join(projectDir(cwd), "agents", "def.md"),
			"---\ndescription: default\n---\nprompt",
		);
		const agents = loadCustomAgents(cwd);
		expect(agents.get("app")?.promptMode).toBe("append");
		expect(agents.get("rep")?.promptMode).toBe("replace");
		expect(agents.get("def")?.promptMode).toBe("replace"); // default
	});

	test("enabled: false disables agent", () => {
		const cwd = mkdtempSync(join(tempDir(), "pixsa-"));
		mkdirSync(join(projectDir(cwd), "agents"), { recursive: true });
		writeFileSync(join(projectDir(cwd), "agents", "off.md"), "---\nenabled: false\n---\nprompt");
		const agents = loadCustomAgents(cwd);
		expect(agents.get("off")?.enabled).toBe(false);
	});

	test("disallowed_tools CSV is parsed", () => {
		const cwd = mkdtempSync(join(tempDir(), "pixsa-"));
		mkdirSync(join(projectDir(cwd), "agents"), { recursive: true });
		writeFileSync(
			join(projectDir(cwd), "agents", "deny.md"),
			"---\ndisallowed_tools: bash, edit\n---\nprompt",
		);
		const agents = loadCustomAgents(cwd);
		expect(agents.get("deny")?.disallowedTools).toEqual(["bash", "edit"]);
	});

	test("source is set to 'project' for .pi/agents/", () => {
		const cwd = mkdtempSync(join(tempDir(), "pixsa-"));
		mkdirSync(join(projectDir(cwd), "agents"), { recursive: true });
		writeFileSync(join(projectDir(cwd), "agents", "src.md"), "---\ndescription: test\n---\nprompt");
		const agents = loadCustomAgents(cwd);
		expect(agents.get("src")?.source).toBe("project");
	});

	test("ext: selectors in tools CSV are separated from builtin names", () => {
		const cwd = mkdtempSync(join(tempDir(), "pixsa-"));
		mkdirSync(join(projectDir(cwd), "agents"), { recursive: true });
		writeFileSync(
			join(projectDir(cwd), "agents", "mixed.md"),
			"---\ntools: read, grep, ext:mcp, ext:mcp/list_tools\n---\nprompt",
		);
		const agents = loadCustomAgents(cwd);
		const mixed = agents.get("mixed");
		if (!mixed) throw new Error("expected 'mixed' agent to exist");
		expect(mixed.builtinToolNames).toEqual(["read", "grep"]);
		expect(mixed.extSelectors).toEqual(["ext:mcp", "ext:mcp/list_tools"]);
	});
});

// ── edge cases ───────────────────────────────────────────────────────────

describe("edge cases", () => {
	test("non-existent .pi/agents dir → empty map", () => {
		const cwd = mkdtempSync(join(tempDir(), "pixsa-"));
		const agents = loadCustomAgents(cwd);
		expect(agents.size).toBe(0);
	});

	test("non-.md files are ignored", () => {
		const cwd = mkdtempSync(join(tempDir(), "pixsa-"));
		mkdirSync(join(projectDir(cwd), "agents"), { recursive: true });
		writeFileSync(join(projectDir(cwd), "agents", "notes.txt"), "not an agent");
		writeFileSync(
			join(projectDir(cwd), "agents", "real.md"),
			"---\ndescription: real agent\n---\nprompt",
		);
		const agents = loadCustomAgents(cwd);
		expect(agents.has("notes")).toBe(false);
		expect(agents.has("real")).toBe(true);
	});
});
