import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@xynogen/pix-runtime/paths";
import { getAuthForUrl } from "../src/mcp-auth.ts";
import { McpOAuthProvider } from "../src/mcp-oauth-provider.ts";

const serverUrl = "https://resource.example/mcp";
const issuer = "https://auth.example";
const client = { client_id: "client", client_secret: "secret", issuer };
const tokens = { access_token: "access", token_type: "Bearer", refresh_token: "refresh", issuer };
const callbacks = { onRedirect() {} };

describe("OAuth issuer persistence", () => {
	const originalDir = process.env.MCP_OAUTH_DIR;
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tempDir(), "pix-oauth-issuer-"));
		process.env.MCP_OAUTH_DIR = dir;
	});

	afterEach(() => {
		if (originalDir === undefined) delete process.env.MCP_OAUTH_DIR;
		else process.env.MCP_OAUTH_DIR = originalDir;
		rmSync(dir, { recursive: true, force: true });
	});

	it.each([
		false,
		true,
	])("round-trips issuer stamps across provider recreation (static: %j)", async (staticClient) => {
		const config = staticClient ? { clientId: "client", clientSecret: "secret" } : {};
		const provider = new McpOAuthProvider("server", serverUrl, config, callbacks);
		await provider.saveClientInformation(client);
		await provider.saveTokens(tokens);
		expect(getAuthForUrl("server", serverUrl)).toMatchObject({
			clientInfo: { issuer },
			tokens: { issuer },
		});
		const restored = new McpOAuthProvider("server", serverUrl, config, callbacks);
		expect(await restored.clientInformation()).toMatchObject(client);
		expect(await restored.tokens()).toMatchObject(tokens);
	});

	it("does not reuse an issuer binding for changed static credentials or server URL", async () => {
		const provider = new McpOAuthProvider("server", serverUrl, {}, callbacks);
		await provider.saveClientInformation(client);
		await provider.saveTokens(tokens);
		for (const config of [
			{ clientId: "other", clientSecret: "secret" },
			{ clientId: "client", clientSecret: "other" },
		]) {
			const changed = new McpOAuthProvider("server", serverUrl, config, callbacks);
			expect(await changed.clientInformation()).toMatchObject({
				client_id: config.clientId,
				client_secret: config.clientSecret,
				issuer: undefined,
			});
		}
		const changed = new McpOAuthProvider("server", "https://other.example/mcp", {}, callbacks);
		expect(await changed.clientInformation()).toBeUndefined();
		expect(await changed.tokens()).toBeUndefined();
	});

	it("retains legacy credentials and accepts the SDK's first-use issuer stamp", async () => {
		const provider = new McpOAuthProvider("server", serverUrl, {}, callbacks);
		await provider.saveClientInformation({ client_id: "client" });
		await provider.saveTokens({ access_token: "access", token_type: "Bearer" });
		expect(await provider.clientInformation()).toMatchObject({
			client_id: "client",
			issuer: undefined,
		});
		expect(await provider.tokens()).toMatchObject({ access_token: "access", issuer: undefined });
		await provider.saveClientInformation({ ...(await provider.clientInformation())!, issuer });
		await provider.saveTokens({ ...(await provider.tokens())!, issuer });
		expect(await provider.clientInformation()).toMatchObject({ client_id: "client", issuer });
		expect(await provider.tokens()).toMatchObject({ access_token: "access", issuer });
	});
});
