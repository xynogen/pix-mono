import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import * as nodeOs from "node:os";
import { dirname, join, resolve } from "node:path";

const { tmpdir } = nodeOs;
const systemHomedir = nodeOs.homedir();
mock.module("node:os", () => ({
	...nodeOs,
	homedir: () => process.env.HOME ?? systemHomedir,
}));

let configModuleId = 0;
function importConfig() {
	return import(`../src/config.ts?bun-test=${configModuleId++}`) as Promise<
		typeof import("../src/config.ts")
	>;
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function readJson(path: string): Record<string, any> {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as Record<string, any>;
	} catch (cause) {
		throw new Error(`Cannot parse test JSON at ${path}`, { cause });
	}
}

describe("config discovery", () => {
	const originalHome = process.env.HOME;
	const originalCwd = process.cwd();

	afterEach(() => {
		process.env.HOME = originalHome;
		process.chdir(originalCwd);
	});

	it("loads standard MCP files first, then Pi overrides", async () => {
		const home = mkdtempSync(join(tmpdir(), "pi-mcp-config-home-"));
		const project = mkdtempSync(join(tmpdir(), "pi-mcp-config-project-"));
		process.env.HOME = home;
		process.chdir(project);

		writeJson(join(home, ".config", "mcp", "mcp.json"), {
			settings: { idleTimeout: 5, requestTimeoutMs: 1500 },
			mcpServers: {
				shared: { command: "generic" },
				genericOnly: { command: "generic-only" },
			},
		});

		writeJson(join(home, ".pi", "agent", "mcp.json"), {
			settings: { toolPrefix: "short", directTools: true },
			mcpServers: {
				shared: { command: "pi-global" },
				piOnly: { command: "pi-only" },
			},
		});

		writeJson(join(project, ".mcp.json"), {
			settings: { toolPrefix: "none" },
			mcpServers: {
				shared: { command: "project" },
				projectOnly: { command: "project-only" },
			},
		});

		writeJson(join(project, ".pi", "mcp.json"), {
			settings: { autoAuth: true },
			mcpServers: {
				shared: { command: "project-pi" },
				projectPiOnly: { command: "project-pi-only" },
			},
		});

		const { loadMcpConfig } = await importConfig();
		const config = loadMcpConfig();

		expect(config.mcpServers.shared).toMatchObject({ command: "project-pi" });
		expect(config.mcpServers.genericOnly).toMatchObject({ command: "generic-only" });
		expect(config.mcpServers.piOnly).toMatchObject({ command: "pi-only" });
		expect(config.mcpServers.projectOnly).toMatchObject({ command: "project-only" });
		expect(config.mcpServers.projectPiOnly).toMatchObject({ command: "project-pi-only" });
		expect(config.settings).toEqual({
			idleTimeout: 5,
			requestTimeoutMs: 1500,
			toolPrefix: "none",
			directTools: true,
			autoAuth: true,
		});
	});

	it("prefers modern Claude Code config detection over legacy paths", async () => {
		const home = mkdtempSync(join(tmpdir(), "pi-mcp-import-home-"));
		const project = mkdtempSync(join(tmpdir(), "pi-mcp-import-project-"));
		process.env.HOME = home;
		process.chdir(project);
		const realProject = realpathSync(project);

		writeJson(join(home, ".claude", "mcp.json"), { mcpServers: { modern: { command: "modern" } } });
		writeJson(join(home, ".claude.json"), { mcpServers: { old: { command: "old" } } });
		writeJson(join(project, ".vscode", "mcp.json"), {
			mcpServers: { editor: { command: "code" } },
		});

		const { findAvailableImportConfigs } = await importConfig();
		const imports = findAvailableImportConfigs();

		expect(imports).toEqual(
			expect.arrayContaining([
				{ kind: "claude-code", path: join(home, ".claude", "mcp.json") },
				{ kind: "vscode", path: resolve(realProject, ".vscode", "mcp.json") },
			]),
		);
	});

	it("merges partial Pi overrides into shared and imported server definitions", async () => {
		const home = mkdtempSync(join(tmpdir(), "pi-mcp-merge-home-"));
		const project = mkdtempSync(join(tmpdir(), "pi-mcp-merge-project-"));
		process.env.HOME = home;
		process.chdir(project);

		writeJson(join(home, ".config", "mcp", "mcp.json"), {
			mcpServers: {
				sharedServer: { command: "shared", args: ["--stdio"], env: { TOKEN: "shared-token" } },
			},
		});

		writeJson(join(home, ".cursor", "mcp.json"), {
			mcpServers: {
				importedStdio: {
					command: "cursor-stdio",
					args: ["--from-cursor"],
					env: { TOKEN: "cursor-token" },
				},
				importedHttp: {
					url: "https://api.example.com/mcp",
					headers: { Authorization: "Bearer imported" },
					auth: "bearer",
				},
			},
		});

		writeJson(join(home, ".pi", "agent", "mcp.json"), {
			imports: ["cursor"],
			mcpServers: {
				sharedServer: { directTools: true },
				importedStdio: { directTools: ["search"] },
				importedHttp: { directTools: true, auth: false },
			},
		});

		const { loadMcpConfig } = await importConfig();
		const config = loadMcpConfig();

		expect(config.mcpServers.sharedServer).toEqual({
			command: "shared",
			args: ["--stdio"],
			env: { TOKEN: "shared-token" },
			directTools: true,
		});
		expect(config.mcpServers.importedStdio).toEqual({
			command: "cursor-stdio",
			args: ["--from-cursor"],
			env: { TOKEN: "cursor-token" },
			directTools: ["search"],
		});
		expect(config.mcpServers.importedHttp).toEqual({
			url: "https://api.example.com/mcp",
			headers: { Authorization: "Bearer imported" },
			auth: false,
			directTools: true,
		});
	});

	it("tracks provenance so project servers write locally and shared/imported servers write to Pi config", async () => {
		const home = mkdtempSync(join(tmpdir(), "pi-mcp-provenance-home-"));
		const project = mkdtempSync(join(tmpdir(), "pi-mcp-provenance-project-"));
		process.env.HOME = home;
		process.chdir(project);
		const realProject = realpathSync(project);

		writeJson(join(home, ".config", "mcp", "mcp.json"), {
			mcpServers: {
				genericServer: { command: "generic" },
			},
		});

		writeJson(join(home, ".pi", "agent", "mcp.json"), {
			imports: ["cursor"],
			mcpServers: {
				userServer: { command: "user" },
			},
		});

		writeJson(join(home, ".cursor", "mcp.json"), {
			mcpServers: {
				importedServer: { command: "cursor" },
			},
		});

		writeJson(join(project, ".mcp.json"), {
			mcpServers: {
				projectServer: { command: "project" },
			},
		});

		writeJson(join(project, ".pi", "mcp.json"), {
			mcpServers: {
				projectPiServer: { command: "project-pi" },
			},
		});

		const { getServerProvenance, getPiGlobalConfigPath } = await importConfig();
		const provenance = getServerProvenance();
		const piConfigPath = getPiGlobalConfigPath();

		expect(provenance.get("genericServer")).toEqual({
			path: piConfigPath,
			kind: "import",
			importKind: "global MCP config",
		});
		expect(provenance.get("importedServer")).toEqual({
			path: piConfigPath,
			kind: "import",
			importKind: "cursor",
		});
		expect(provenance.get("userServer")).toEqual({
			path: piConfigPath,
			kind: "user",
			importKind: undefined,
		});
		expect(provenance.get("projectServer")).toEqual({
			path: resolve(realProject, ".mcp.json"),
			kind: "project",
			importKind: undefined,
		});
		expect(provenance.get("projectPiServer")).toEqual({
			path: resolve(realProject, ".pi", "mcp.json"),
			kind: "project",
			importKind: undefined,
		});
	});

	it("summarizes discovery and detects RepoPrompt suggestions", async () => {
		const home = mkdtempSync(join(tmpdir(), "pi-mcp-summary-home-"));
		const project = mkdtempSync(join(tmpdir(), "pi-mcp-summary-project-"));
		process.env.HOME = home;
		process.chdir(project);
		const realProject = realpathSync(project);

		writeJson(join(home, ".config", "mcp", "mcp.json"), {
			mcpServers: {
				sharedServer: { command: "shared" },
			},
		});

		writeJson(join(project, "package.json"), { name: "fixture" });
		writeJson(join(home, "RepoPrompt", "repoprompt_cli"), "#!/bin/sh\n");
		writeJson(join(home, ".cursor", "mcp.json"), {
			mcpServers: {
				importedServer: { command: "cursor" },
			},
		});

		const { getMcpDiscoverySummary } = await importConfig();
		const summary = getMcpDiscoverySummary();

		expect(summary.hasSharedServers).toBe(true);
		expect(summary.sources.find((source) => source.id === "shared-global")?.serverCount).toBe(1);
		expect(summary.imports).toEqual(
			expect.arrayContaining([expect.objectContaining({ kind: "cursor", serverCount: 1 })]),
		);
		expect(summary.repoPrompt).toMatchObject({
			configured: false,
			executablePath: join(home, "RepoPrompt", "repoprompt_cli"),
			targetPath: resolve(realProject, ".mcp.json"),
			serverName: "repoprompt",
		});
	});

	it("writes imported/global changes to Pi config and project changes to the project file", async () => {
		const home = mkdtempSync(join(tmpdir(), "pi-mcp-write-home-"));
		const project = mkdtempSync(join(tmpdir(), "pi-mcp-write-project-"));
		process.env.HOME = home;
		process.chdir(project);

		writeJson(join(home, ".config", "mcp", "mcp.json"), {
			mcpServers: {
				genericServer: { command: "generic" },
			},
		});

		writeJson(join(home, ".pi", "agent", "mcp.json"), {
			mcpServers: {},
		});

		writeJson(join(project, ".mcp.json"), {
			mcpServers: {
				projectServer: { command: "project" },
			},
		});

		const { getServerProvenance, loadMcpConfig, writeDirectToolsConfig, getPiGlobalConfigPath } =
			await importConfig();
		const fullConfig = loadMcpConfig();
		const provenance = getServerProvenance();

		writeDirectToolsConfig(
			new Map<string, boolean | string[]>([
				["genericServer", true],
				["projectServer", ["search"]],
			]),
			provenance,
			fullConfig,
		);

		const userConfig = readJson(getPiGlobalConfigPath());
		expect(userConfig.mcpServers.genericServer).toMatchObject({
			command: "generic",
			directTools: true,
		});

		const projectConfig = readJson(join(project, ".mcp.json"));
		expect(projectConfig.mcpServers.projectServer).toMatchObject({
			command: "project",
			directTools: ["search"],
		});
	});

	it("builds real diff previews for compatibility imports and shared server writes", async () => {
		const home = mkdtempSync(join(tmpdir(), "pi-mcp-preview-home-"));
		const project = mkdtempSync(join(tmpdir(), "pi-mcp-preview-project-"));
		process.env.HOME = home;
		process.chdir(project);

		writeJson(join(home, ".pi", "agent", "mcp.json"), {
			imports: ["cursor"],
			mcpServers: {
				existing: { command: "demo" },
			},
		});

		const { previewCompatibilityImports, previewSharedServerEntry, getGenericGlobalConfigPath } =
			await importConfig();

		const importsPreview = previewCompatibilityImports(["cursor", "codex"]);
		expect(importsPreview.path).toContain(".pi/agent/mcp.json");
		expect(importsPreview.changed).toBe(true);
		expect(importsPreview.diffText).toContain("+++ after");
		expect(importsPreview.diffText).toContain('+     "codex"');

		const sharedPreview = previewSharedServerEntry(getGenericGlobalConfigPath(), "repoprompt", {
			command: "/tmp/repoprompt_cli",
			args: [],
			lifecycle: "lazy",
		});
		expect(sharedPreview.existed).toBe(false);
		expect(sharedPreview.diffText).toContain('+   "mcpServers": {');
		expect(sharedPreview.diffText).toContain('+     "repoprompt": {');
	});

	it("previews and removes a server entry, leaving siblings intact", async () => {
		const home = mkdtempSync(join(tmpdir(), "pi-mcp-remove-home-"));
		process.env.HOME = home;

		const cfgPath = join(home, ".pi", "agent", "mcp.json");
		writeJson(cfgPath, { mcpServers: { keep: { command: "a" }, drop: { command: "b" } } });

		const { previewRemoveServerEntry, removeServerEntry } = await importConfig();

		const preview = previewRemoveServerEntry(cfgPath, "drop");
		expect(preview.changed).toBe(true);
		expect(preview.diffText).toContain('-     "drop": {');
		expect(preview.diffText).toContain('  "keep"'); // keep survives (context line)

		removeServerEntry(cfgPath, "drop");
		const after = readJson(cfgPath);
		expect(after.mcpServers).toEqual({ keep: { command: "a" } });
	});

	it("writes selected compatibility imports and a starter project config", async () => {
		const home = mkdtempSync(join(tmpdir(), "pi-mcp-setup-home-"));
		const project = mkdtempSync(join(tmpdir(), "pi-mcp-setup-project-"));
		process.env.HOME = home;
		process.chdir(project);

		const { ensureCompatibilityImports, getPiGlobalConfigPath, writeStarterProjectConfig } =
			await importConfig();
		const importResult = ensureCompatibilityImports(["cursor", "codex"]);
		expect(importResult.added).toEqual(["cursor", "codex"]);

		const piConfig = readJson(getPiGlobalConfigPath());
		expect(piConfig.imports).toEqual(["cursor", "codex"]);

		const starterPath = writeStarterProjectConfig();
		const starter = readJson(starterPath);
		expect(starter.mcpServers).toEqual({});
	});
});
