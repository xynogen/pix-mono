import { afterEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import * as nodeOs from "node:os";
import { join } from "node:path";

const { tmpdir } = nodeOs;
const systemHomedir = nodeOs.homedir();
mock.module("node:os", () => ({
	...nodeOs,
	homedir: () => process.env.HOME ?? systemHomedir,
}));

describe("Pi agent dir paths", () => {
	const originalHome = process.env.HOME;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalOAuthDir = process.env.MCP_OAUTH_DIR;

	afterEach(() => {
		process.env.HOME = originalHome;
		if (originalAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		}
		if (originalOAuthDir === undefined) {
			delete process.env.MCP_OAUTH_DIR;
		} else {
			process.env.MCP_OAUTH_DIR = originalOAuthDir;
		}
	});

	it("uses PI_CODING_AGENT_DIR for Pi-owned config and state files", async () => {
		const home = mkdtempSync(join(tmpdir(), "pi-mcp-agent-dir-home-"));
		const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-agent-dir-"));
		process.env.HOME = home;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		delete process.env.MCP_OAUTH_DIR;

		const { getAgentDir } = await import("../src/agent-dir.ts");
		const { getPiGlobalConfigPath, resolveAddTargetPath } = await import("../src/config.ts");
		const { getMetadataCachePath } = await import("../src/metadata-cache.ts");
		const { getOnboardingStatePath } = await import("../src/onboarding-state.ts");
		const { getAuthEntryFilePath, saveAuthEntry } = await import("../src/mcp-auth.ts");

		expect(getAgentDir()).toBe(agentDir);
		expect(getPiGlobalConfigPath()).toBe(join(agentDir, "mcp.json"));
		expect(resolveAddTargetPath("global")).toBe(join(agentDir, "mcp.json"));
		expect(getMetadataCachePath()).toBe(join(agentDir, "mcp-cache.json"));
		expect(getOnboardingStatePath()).toBe(join(agentDir, "mcp-onboarding.json"));

		saveAuthEntry("demo", { tokens: { accessToken: "token" } }, "https://example.com/mcp");
		expect(existsSync(getAuthEntryFilePath("demo"))).toBe(true);
		expect(getAuthEntryFilePath("demo").startsWith(join(agentDir, "mcp-oauth"))).toBe(true);
		expect(existsSync(join(agentDir, "mcp-oauth", "demo", "tokens.json"))).toBe(false);
		expect(existsSync(join(home, ".pi", "agent", "mcp-oauth", "demo", "tokens.json"))).toBe(false);
	});

	it("expands tilde in PI_CODING_AGENT_DIR", async () => {
		const home = mkdtempSync(join(tmpdir(), "pi-mcp-agent-dir-home-"));
		process.env.HOME = home;
		process.env.PI_CODING_AGENT_DIR = "~/custom-pi-agent";

		const { getAgentDir } = await import("../src/agent-dir.ts");

		expect(getAgentDir()).toBe(join(home, "custom-pi-agent"));
	});

	it("keeps MCP_OAUTH_DIR as the explicit OAuth storage override", async () => {
		const home = mkdtempSync(join(tmpdir(), "pi-mcp-agent-dir-home-"));
		const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-agent-dir-"));
		const oauthDir = mkdtempSync(join(tmpdir(), "pi-mcp-oauth-dir-"));
		process.env.HOME = home;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.MCP_OAUTH_DIR = oauthDir;

		const { getAuthEntryFilePath, saveAuthEntry } = await import("../src/mcp-auth.ts");

		saveAuthEntry("demo", { tokens: { accessToken: "token" } }, "https://example.com/mcp");
		expect(existsSync(getAuthEntryFilePath("demo"))).toBe(true);
		expect(getAuthEntryFilePath("demo").startsWith(oauthDir)).toBe(true);
		expect(existsSync(join(oauthDir, "demo", "tokens.json"))).toBe(false);
		expect(existsSync(join(agentDir, "mcp-oauth", "demo", "tokens.json"))).toBe(false);
	});
});
