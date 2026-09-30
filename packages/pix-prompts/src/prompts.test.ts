import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { tempDir } from "@xynogen/pix-runtime/paths";
import registerPrompts, { resolveOwnSopMd } from "./prompts.ts";

type Handler = (event: { systemPrompt?: string }) => Promise<{ systemPrompt?: string } | undefined>;

/** Minimal fake pi that captures the before_agent_start handler. */
function fakePi(): { pi: ExtensionAPI; getHandler: () => Handler } {
	let handler: Handler | undefined;
	const pi = {
		on(event: string, fn: Handler) {
			if (event === "before_agent_start") handler = fn;
		},
	} as unknown as ExtensionAPI;
	return {
		pi,
		getHandler: () => {
			if (!handler) throw new Error("handler not registered");
			return handler;
		},
	};
}

describe("pix-prompts host-aware injection", () => {
	let dir: string;
	let prevCwd: string;

	beforeEach(() => {
		prevCwd = process.cwd();
		dir = mkdtempSync(join(tempDir(), "pix-prompts-"));
		process.chdir(dir);
	});

	afterEach(() => {
		process.chdir(prevCwd);
		rmSync(dir, { recursive: true, force: true });
	});

	it("resolves the bundled SOP.md to a real file and injects it", async () => {
		// Regression: URL.pathname made "C:\\C:\\..." on Windows and SOP was silently skipped.
		expect(existsSync(resolveOwnSopMd())).toBe(true);
		const { pi, getHandler } = fakePi();
		registerPrompts(pi);
		const result = await getHandler()({ systemPrompt: "BASE" });
		expect(result?.systemPrompt).toMatch(/<pix-agent-sop>\n# Agent Operating Specification/);
	});

	it("injects a repo directive file the host has NOT already injected", async () => {
		writeFileSync(join(dir, "GEMINI.md"), "gemini rules");
		const { pi, getHandler } = fakePi();
		registerPrompts(pi);

		const result = await getHandler()({ systemPrompt: "BASE" });

		expect(result?.systemPrompt).toContain("<pix-prompts-gemini-md>");
		expect(result?.systemPrompt).toContain("gemini rules");
	});

	it("SKIPS a file the host already injected as <project_instructions path>", async () => {
		const agentsPath = join(dir, "AGENTS.md");
		writeFileSync(agentsPath, "repo directives");
		const { pi, getHandler } = fakePi();
		registerPrompts(pi);

		// Simulate the host having already injected AGENTS.md verbatim.
		const hostPrompt = `BASE\n<project_instructions path="${agentsPath}">\nrepo directives\n</project_instructions>`;
		const result = await getHandler()({ systemPrompt: hostPrompt });

		// pix-prompts still injects its own bundled baseline (<pix-agent-sop>),
		// but must NOT re-wrap AGENTS.md in its own tag (host already has it).
		expect(result?.systemPrompt).not.toContain("<pix-prompts-agents-md>");
	});

	it("does NOT inject AGENTS.md / CLAUDE.md — host resource-loader owns those", async () => {
		// The host unconditionally loads AGENTS.md / CLAUDE.md as
		// <project_instructions path="...">. pix-prompts must not also inject them;
		// a path-normalization mismatch broke the string-match dedup and silently
		// double-injected them (~2500 wasted tokens/turn). Host coverage wins.
		writeFileSync(join(dir, "AGENTS.md"), "repo directives");
		writeFileSync(join(dir, "CLAUDE.md"), "claude directives");
		const { pi, getHandler } = fakePi();
		registerPrompts(pi);

		const result = await getHandler()({ systemPrompt: "BASE" });

		expect(result?.systemPrompt).not.toContain("<pix-prompts-agents-md>");
		expect(result?.systemPrompt).not.toContain("<pix-prompts-claude-md>");
	});

	it("is idempotent on retry — does not double-inject its own tag", async () => {
		writeFileSync(join(dir, "GEMINI.md"), "gemini rules");
		const { pi, getHandler } = fakePi();
		registerPrompts(pi);

		const first = await getHandler()({ systemPrompt: "BASE" });
		const second = await getHandler()({ systemPrompt: first?.systemPrompt });

		// Second pass finds its own tag already present → nothing new.
		expect(second).toBeUndefined();
		const occurrences = (first?.systemPrompt ?? "").split("<pix-prompts-gemini-md>").length - 1;
		expect(occurrences).toBe(1);
	});

	it("truncates oversized repo directive files at the byte cap", async () => {
		writeFileSync(join(dir, "GEMINI.md"), "x".repeat(20 * 1024));
		const { pi, getHandler } = fakePi();
		registerPrompts(pi);

		const result = await getHandler()({ systemPrompt: "BASE" });

		expect(result?.systemPrompt).toContain("[pix-prompts: truncated at 16384 bytes]");
		// Injected block must not carry the full 20KB.
		const block = result?.systemPrompt?.split("<pix-prompts-gemini-md>")[1] ?? "";
		expect(block.length).toBeLessThan(17 * 1024);
	});

	it("instructs the agent to offer isolated dependency installation", async () => {
		const { pi, getHandler } = fakePi();
		registerPrompts(pi);

		const result = await getHandler()({ systemPrompt: "BASE" });

		expect(result?.systemPrompt).toContain(
			"ask whether the user wants it installed instead of stopping at installation instructions",
		);
		expect(result?.systemPrompt).toContain("isolated user- or project-scoped installation");
	});

	it("bundled SOP names lens_diagnostics and drops lsp_diagnostics", () => {
		const sop = readFileSync(join(import.meta.dir, "..", "SOP.md"), "utf8");
		expect(sop).toContain("lens_diagnostics");
		expect(sop).not.toContain("lsp_diagnostics");
	});

	it("replaces pi's default identity line with generic version", async () => {
		const { pi, getHandler } = fakePi();
		registerPrompts(pi);

		const piDefault =
			"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";
		const result = await getHandler()({ systemPrompt: piDefault });

		// Should replace the restrictive identity line
		expect(result?.systemPrompt).not.toContain(
			"You are an expert coding assistant operating inside pi",
		);
		expect(result?.systemPrompt).toContain("You are Pix Coding Agent");
	});
});
