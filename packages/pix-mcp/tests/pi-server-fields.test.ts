import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyPiServerFields,
	isServerNameTaken,
	loadMcpConfig,
	takeUnsupportedConfigNotes,
	withDirectChoice,
} from "../src/config.ts";
import {
	resolveCommandValue,
	resolveConfigRecord,
	resolveOAuthSecret,
} from "../src/config-value.ts";
import {
	capToolName,
	codemodeToolName,
	getMissingConfiguredDirectToolServers,
	resolveCodemodeTools,
	resolveDirectTools,
} from "../src/direct-tools.ts";
import { computeServerHash, type MetadataCache } from "../src/metadata-cache.ts";
import { McpServerManager } from "../src/server-manager.ts";
import { getToolExposure, type McpConfig, type ServerEntry } from "../src/types.ts";

function cacheFor(config: McpConfig, tools: string[], instructions?: string): MetadataCache {
	const servers: MetadataCache["servers"] = {};
	for (const [name, definition] of Object.entries(config.mcpServers)) {
		servers[name] = {
			configHash: computeServerHash(definition),
			cachedAt: Date.now(),
			tools: tools.map((tool) => ({ name: tool })),
			resources: [],
			...(instructions ? { instructions } : {}),
		};
	}
	return { version: 1, servers };
}

describe("Pi mcp.json server fields", () => {
	it("drops enabled:false servers unless includeDisabled", () => {
		const config: McpConfig = {
			mcpServers: { off: { command: "a", enabled: false }, on: { command: "b", enabled: true } },
		};
		expect(Object.keys(applyPiServerFields(config).mcpServers)).toEqual(["on"]);
		expect(Object.keys(applyPiServerFields(config, {}, true).mcpServers)).toEqual(["off", "on"]);
	});

	it("drops a description, enabled, or timeout of the wrong type and notes it", () => {
		takeUnsupportedConfigNotes();
		const config = {
			mcpServers: { s: { command: "x", description: 123, enabled: "no", timeout: "5" } },
		} as unknown as McpConfig;
		expect(applyPiServerFields(config).mcpServers.s).toEqual({ command: "x" });
		expect(takeUnsupportedConfigNotes()).toEqual([
			"s: description must be a string",
			"s: enabled must be a boolean",
			"s: timeout must be a positive number of seconds",
		]);
	});

	it("lists disabled servers for the panel and the name check", () => {
		const dir = mkdtempSync(join(tmpdir(), "pix-mcp-cfg-"));
		const path = join(dir, "mcp.json");
		writeFileSync(path, JSON.stringify({ mcpServers: { off: { command: "a", enabled: false } } }));
		expect(Object.keys(loadMcpConfig(path, dir).mcpServers)).toEqual([]);
		expect(Object.keys(loadMcpConfig(path, dir, { includeDisabled: true }).mcpServers)).toEqual([
			"off",
		]);
		expect(isServerNameTaken("off", path, dir)).toBe(true);
	});

	it("keeps auth.provider only from the global Pi file, for the same safe URL", () => {
		takeUnsupportedConfigNotes();
		const auth = { provider: "github" };
		const global: Record<string, ServerEntry> = {
			ok: { url: "https://a", auth },
			local: { url: "http://127.0.0.1:9/mcp", auth },
			moved: { url: "https://a", auth },
			plain: { url: "http://example.com", auth },
		};
		const merged: McpConfig = {
			mcpServers: {
				...global,
				moved: { url: "https://evil", auth },
				project: { url: "https://b", auth },
			},
		};
		const out = applyPiServerFields(merged, global).mcpServers;
		const kept = Object.entries(out).filter(([, entry]) => typeof entry.auth === "object");
		expect(kept.map(([name]) => name)).toEqual(["ok", "local"]);
		expect(takeUnsupportedConfigNotes()).toEqual([
			"moved: auth.provider is only allowed in the global Pi mcp.json",
			"plain: auth.provider needs https, or http on localhost",
			"project: auth.provider is only allowed in the global Pi mcp.json",
		]);
	});

	it("resolves exposure in Pi order and notes invalid values once", () => {
		takeUnsupportedConfigNotes();
		const config = {
			mcpServers: {
				s: {
					command: "x",
					exposure: "codemode-deferred",
					toolExposure: { read_a: "direct", "read_*": "hidden", "*": "deferred", bad: "nope" },
				},
			},
		} as unknown as McpConfig;
		const entry = applyPiServerFields(config).mcpServers.s!;
		expect(entry.exposure).toBe("codemode");
		expect(getToolExposure(entry, "read_a")).toBe("direct");
		expect(getToolExposure(entry, "read_b")).toBe("hidden");
		expect(getToolExposure(entry, "other")).toBe("deferred");
		expect(getToolExposure({}, "other")).toBeUndefined();
		expect(takeUnsupportedConfigNotes()).toEqual(['s: toolExposure "bad"']);
		applyPiServerFields(config);
		expect(takeUnsupportedConfigNotes()).toEqual([]);
	});

	it("uses exposure for direct and hidden tools, over legacy directTools", () => {
		const config: McpConfig = {
			mcpServers: {
				s: {
					command: "x",
					directTools: true,
					exposure: "hidden",
					toolExposure: { a: "direct", b: "deferred" },
				},
			},
		};
		const cache = cacheFor(config, ["a", "b", "c"]);
		expect(resolveDirectTools(config, cache, "server").map((s) => s.originalName)).toEqual(["a"]);
		expect(resolveCodemodeTools(config, cache).map((s) => s.originalName)).toEqual(["a", "b"]);
		// MCP_DIRECT_TOOLS wins over exposure, but hidden still wins over it.
		const env = resolveDirectTools(config, cache, "server", ["s"]);
		expect(env.map((s) => s.originalName)).toEqual(["a", "b"]);
		expect(getMissingConfiguredDirectToolServers(config, null)).toEqual(["s"]);
	});

	it("falls back to server instructions for the namespace summary", () => {
		const config: McpConfig = { mcpServers: { s: { command: "x" } } };
		const cache = cacheFor(config, ["a"], "Search docs.\nMore detail.");
		const [spec] = resolveCodemodeTools(config, cache);
		expect(spec).toMatchObject({
			serverDescription: "Search docs.",
			serverInstructions: "Search docs.\nMore detail.",
		});
	});

	it("runs !command values once per process and names the key on failure", async () => {
		const log = join(mkdtempSync(join(tmpdir(), "pix-mcp-cmd-")), "runs");
		const cmd = `!echo run >> '${log}'; printf ' tok '`;
		expect(await resolveCommandValue(cmd, "s", "Authorization")).toBe("tok");
		expect(await resolveCommandValue(cmd, "s", "Authorization")).toBe("tok");
		expect(readFileSync(log, "utf-8")).toBe("run\n");
		await expect(resolveCommandValue("!exit 3", "s", "API_KEY")).rejects.toThrow(
			/^MCP server "s": command for "API_KEY" failed \(exit code 3\)$/,
		);
		await expect(resolveCommandValue("!true", "s", "API_KEY")).rejects.toThrow(/\(empty output\)$/);
	});

	it("resolves !command in headers, env, and oauth.clientSecret only", async () => {
		process.env.PIX_MCP_TEST_VAR = "v";
		expect(
			await resolveConfigRecord({ A: "!printf a", B: "$env:PIX_MCP_TEST_VAR", C: "x!" }, "s"),
		).toEqual({ A: "a", B: "v", C: "x!" });
		const entry: ServerEntry = { url: "https://a", oauth: { clientSecret: "!printf sec" } };
		expect((await resolveOAuthSecret(entry, "s")).oauth).toEqual({ clientSecret: "sec" });
		const literal: ServerEntry = { url: "https://a", oauth: { clientSecret: "plain" } };
		expect(await resolveOAuthSecret(literal, "s")).toBe(literal);
		delete process.env.PIX_MCP_TEST_VAR;
	});

	it("sends the provider token per request and asks for /login without one", async () => {
		const manager = new McpServerManager(process.cwd());
		let token: string | undefined = "t1";
		manager.setProviderTokenResolver(async (provider) =>
			provider === "github" ? token : undefined,
		);
		// SAFETY: test reaches the private fetch builder to check the header only.
		const build = (
			manager as unknown as {
				providerFetch(
					d: ServerEntry,
					n: string,
				): ((u: string, i?: RequestInit) => Promise<Response>) | undefined;
			}
		).providerFetch.bind(manager);
		expect(build({ url: "https://a", auth: "bearer" }, "s")).toBeUndefined();
		const providerFetch = build({ url: "https://a", auth: { provider: "github" } }, "s")!;

		const seen: string[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (_url: string, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			seen.push(`${headers.get("Authorization")}|${headers.get("X-Keep")}`);
			return new Response("ok");
		}) as typeof fetch;
		try {
			await providerFetch("https://a", { headers: { "X-Keep": "1", Authorization: "old" } });
			token = "t2";
			await providerFetch("https://a");
			expect(seen).toEqual(["Bearer t1|1", "Bearer t2|null"]);
			token = undefined;
			await expect(providerFetch("https://a")).rejects.toThrow(
				'MCP server "s" needs a github login. Run /login github.',
			);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	it("writes the /mcp toggle as toolExposure for exposure servers", () => {
		const legacy: ServerEntry = { command: "x" };
		expect(withDirectChoice(legacy, ["a"], ["a", "b"])).toEqual({
			command: "x",
			directTools: ["a"],
		});
		const exposed: ServerEntry = {
			command: "x",
			exposure: "deferred",
			toolExposure: { b: "direct", c: "hidden" },
		};
		const out = withDirectChoice(exposed, ["a"], ["a", "b"]);
		expect(out.toolExposure).toEqual({ a: "direct", b: "codemode", c: "hidden" });
		expect(out.directTools).toBeUndefined();
		expect(withDirectChoice(exposed, false, ["b"]).toolExposure?.b).toBe("codemode");
	});

	it("pins the codemode hash rule that pix-toolbox mirrors", () => {
		expect(codemodeToolName("a-b", "c", true)).toBe("mcp__a_b__c_695274f6");
		expect(codemodeToolName("a__b", "c", true)).toBe("mcp__a__b__c_a92700ce");
		expect(codemodeToolName("srv", "x".repeat(70))).toBe(`mcp__srv__${"x".repeat(45)}_fe6c03e8`);
	});

	it("uses a per-server timeout in seconds before the scaled shared default", () => {
		const manager = new McpServerManager(process.cwd());
		manager.setDefaultRequestTimeoutMs(1000);
		// SAFETY: test reaches the private builder to check the timeout choice only.
		const build = (
			manager as unknown as {
				buildRequestOptions(d?: { timeout?: number }): { timeout?: number } | undefined;
			}
		).buildRequestOptions.bind(manager);
		expect(build({ timeout: 5 })?.timeout).toBe(5000);
		expect(build({})?.timeout).toBe(3000);
	});
});

describe("direct tool name length", () => {
	it("caps direct tool names at 64 chars and keeps them unique", () => {
		const config: McpConfig = { mcpServers: { srv: { command: "node", directTools: true } } };
		const long = "t".repeat(70);
		const cache: MetadataCache = {
			version: 1,
			servers: {
				srv: {
					configHash: computeServerHash(config.mcpServers.srv!),
					cachedAt: Date.now(),
					tools: [{ name: `${long}a` }, { name: `${long}b` }],
					resources: [],
				},
			},
		};
		const names = resolveDirectTools(config, cache, "server").map((s) => s.prefixedName);
		for (const name of names) expect(name).toMatch(/^srv_t+_[0-9a-f]{8}$/);
		for (const name of names) expect(name).toHaveLength(64);
		expect(new Set(names).size).toBe(2);
		expect(capToolName("short", "k")).toBe("short");
	});
});
