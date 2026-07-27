import { afterEach, describe, expect, it, mock } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import * as nodeOs from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { tmpdir } = nodeOs;
const systemHomedir = nodeOs.homedir();
mock.module("node:os", () => ({
	...nodeOs,
	default: {
		...nodeOs,
		homedir: () => process.env.HOME ?? systemHomedir,
	},
	homedir: () => process.env.HOME ?? systemHomedir,
}));

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function readJson(path: string): Record<string, unknown> {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
	} catch (cause) {
		throw new Error(`Cannot parse test JSON at ${path}`, { cause });
	}
}

let cliModuleId = 0;
function importCli() {
	return import(`../cli.ts?bun-test=${cliModuleId++}`) as Promise<typeof import("../cli.ts")>;
}

describe("cli init helper", () => {
	const originalHome = process.env.HOME;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalCwd = process.cwd();

	afterEach(() => {
		process.env.HOME = originalHome;
		if (originalAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		}
		process.chdir(originalCwd);
	});

	it("adds detected host imports to the Pi config", async () => {
		const home = mkdtempSync(join(tmpdir(), "pi-mcp-cli-home-"));
		const project = mkdtempSync(join(tmpdir(), "pi-mcp-cli-project-"));
		process.env.HOME = home;
		delete process.env.PI_CODING_AGENT_DIR;
		process.chdir(project);

		writeJson(join(home, ".claude", "mcp.json"), {
			mcpServers: {
				claudeServer: { command: "claude" },
			},
		});

		const logs: string[] = [];
		const errors: string[] = [];
		const { main } = await importCli();
		const exitCode = await main(
			["init"],
			(line) => logs.push(line),
			(line) => errors.push(line),
		);

		expect(exitCode).toBe(0);
		expect(errors).toEqual([]);

		const piConfigPath = join(home, ".pi", "agent", "mcp.json");
		expect(existsSync(piConfigPath)).toBe(true);
		const config = readJson(piConfigPath);
		expect(config.imports).toContain("claude-code");
		expect(logs.join("\n")).toContain("Updated");
	});

	it("writes detected host imports to PI_CODING_AGENT_DIR when set", async () => {
		const home = mkdtempSync(join(tmpdir(), "pi-mcp-cli-home-"));
		const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-cli-agent-"));
		const project = mkdtempSync(join(tmpdir(), "pi-mcp-cli-project-"));
		process.env.HOME = home;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.chdir(project);

		writeJson(join(home, ".claude", "mcp.json"), {
			mcpServers: {
				claudeServer: { command: "claude" },
			},
		});

		const logs: string[] = [];
		const errors: string[] = [];
		const { main } = await importCli();
		const exitCode = await main(
			["init"],
			(line) => logs.push(line),
			(line) => errors.push(line),
		);

		expect(exitCode).toBe(0);
		expect(errors).toEqual([]);

		const piConfigPath = join(agentDir, "mcp.json");
		expect(existsSync(piConfigPath)).toBe(true);
		expect(existsSync(join(home, ".pi", "agent", "mcp.json"))).toBe(false);
		const config = readJson(piConfigPath);
		expect(config.imports).toContain("claude-code");
		expect(logs.join("\n")).toContain(piConfigPath);
	});

	it("runs when invoked through a symlinked bin path", () => {
		const home = mkdtempSync(join(tmpdir(), "pi-mcp-cli-home-"));
		const binDir = mkdtempSync(join(tmpdir(), "pi-mcp-cli-bin-"));
		const symlinkPath = join(binDir, "pix-mcp");
		symlinkSync(fileURLToPath(new URL("../cli.ts", import.meta.url)), symlinkPath);

		const result = spawnSync("bun", [symlinkPath, "init", "--dry-run"], {
			cwd: mkdtempSync(join(tmpdir(), "pi-mcp-cli-project-")),
			env: {
				...process.env,
				HOME: home,
				PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
			},
			encoding: "utf-8",
		});

		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("Config discovery:");
		expect(result.stdout).toContain("No Pi config changes needed.");
	});

	it("explains that install now goes through `pi install`", async () => {
		const logs: string[] = [];
		const errors: string[] = [];
		const { main } = await importCli();
		const exitCode = await main(
			["install"],
			(line) => logs.push(line),
			(line) => errors.push(line),
		);

		expect(exitCode).toBe(1);
		expect(errors.join("\n")).toContain("Use `pi install npm:@xynogen/pix-mcp` instead");
		expect(logs).toEqual([]);
	});
});
