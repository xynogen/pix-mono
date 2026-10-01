import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	buildProxyDescription,
	codemodeToolName,
	resolveCodemodeTools,
	resolveDirectTools,
	takeSkippedDirectTools,
} from "../src/direct-tools.ts";
import {
	computeServerHash,
	isServerCacheValid,
	type MetadataCache,
	reconstructToolMetadata,
} from "../src/metadata-cache.ts";
import { buildToolMetadata } from "../src/tool-metadata.ts";
import type { McpConfig } from "../src/types.ts";

const originalHashEnv = {
	MCP_HASH_CWD: process.env.MCP_HASH_CWD,
	MCP_HASH_ENV: process.env.MCP_HASH_ENV,
	MCP_HASH_HEADER: process.env.MCP_HASH_HEADER,
	MCP_HASH_TOKEN: process.env.MCP_HASH_TOKEN,
};

afterEach(() => {
	for (const [key, value] of Object.entries(originalHashEnv)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
});

describe("buildProxyDescription", () => {
	it("keeps proxy guidance compact while covering each mode", () => {
		const config: McpConfig = {
			mcpServers: {
				demo: {
					command: "npx",
					args: ["-y", "demo-server"],
				},
			},
		};

		const cache: MetadataCache = {
			version: 1,
			servers: {
				demo: {
					configHash: "hash",
					cachedAt: Date.now(),
					tools: [
						{
							name: "launch_app",
							description: "Launch the demo app",
							inputSchema: { type: "object", properties: {} },
						},
					],
					resources: [],
				},
			},
		};

		const description = buildProxyDescription(config, cache, []);

		expect(description).toContain("action=auth/UI");
		expect(description).toContain("search=find");
		expect(description).toContain("User names one: use search/server");
		expect(description).toContain("Otherwise use native Pi tools");
		expect(description.length).toBeLessThan(400);
	});

	it("excludes configured tools from proxy summaries", () => {
		const config: McpConfig = {
			settings: { toolPrefix: "server" },
			mcpServers: {
				figma: {
					command: "npx",
					args: ["-y", "figma"],
					excludeTools: ["get_figjam", "figma_get_screenshot"],
				},
			},
		};

		const cache: MetadataCache = {
			version: 1,
			servers: {
				figma: {
					configHash: computeServerHash(config.mcpServers.figma),
					cachedAt: Date.now(),
					tools: [
						{ name: "get_screenshot", description: "Take screenshot" },
						{ name: "get_nodes", description: "Get nodes" },
					],
					resources: [{ name: "figjam", uri: "ui://figjam", description: "FigJam" }],
				},
			},
		};

		const description = buildProxyDescription(config, cache, []);

		expect(description).toContain("Servers: figma (1 tools)");
		expect(description).not.toContain("figma (3 tools)");
	});
});

describe("codemode tool discovery", () => {
	it("exposes cached server tools without adding direct declarations", () => {
		const config: McpConfig = {
			mcpServers: { demo: { command: "node" } },
		};
		const cache: MetadataCache = {
			version: 1,
			servers: {
				demo: {
					configHash: computeServerHash(config.mcpServers.demo),
					cachedAt: Date.now(),
					tools: [{ name: "lookup", description: "Find records", inputSchema: { type: "object" } }],
					resources: [],
				},
			},
		};
		expect(resolveCodemodeTools(config, cache)).toMatchObject([
			{ serverName: "demo", originalName: "lookup", prefixedName: "mcp__demo__lookup" },
		]);
	});

	it("gives sanitized identifiers and hash-suffixes names that sanitize alike", () => {
		const config: McpConfig = {
			mcpServers: { "my-srv": { command: "node", description: "Files, dirs\nsecond line" } },
		};
		const cache: MetadataCache = {
			version: 1,
			servers: {
				"my-srv": {
					configHash: computeServerHash(config.mcpServers["my-srv"]!),
					cachedAt: Date.now(),
					tools: [{ name: "read-file" }, { name: "read_file" }, { name: "list" }],
					resources: [],
				},
			},
		};
		const names = resolveCodemodeTools(config, cache).map((s) => s.prefixedName);
		expect(names[2]).toBe("mcp__my_srv__list");
		for (const name of names.slice(0, 2))
			expect(name).toMatch(/^mcp__my_srv__read_file_[0-9a-f]{8}$/);
		expect(new Set(names).size).toBe(3);
		expect(resolveCodemodeTools(config, cache)[0]?.serverDescription).toBe("Files, dirs");
		expect(buildProxyDescription(config, cache, [])).toContain(
			"Servers: my-srv (3 tools): Files, dirs\n",
		);
	});

	it("caps long names at 64 chars with a hash suffix", () => {
		const name = codemodeToolName("server", "x".repeat(80));
		expect(name).toHaveLength(64);
		expect(name).toMatch(/^mcp__server__x+_[0-9a-f]{8}$/);
	});
});

describe("resource name collisions", () => {
	it("keeps the first resource and warns once across metadata refreshes", () => {
		const config: McpConfig = {
			mcpServers: { demo: { command: "node", exposeResources: true } },
		};
		const cache: MetadataCache = {
			version: 1,
			servers: {
				demo: {
					configHash: computeServerHash(config.mcpServers.demo),
					cachedAt: Date.now(),
					tools: [],
					resources: [
						{ name: "unique_table", uri: "demo://unique" },
						{ name: "unique_table_", uri: "demo://duplicate" },
					],
				},
			},
		};
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			takeSkippedDirectTools();
			const first = resolveCodemodeTools(config, cache);
			expect(first).toMatchObject([
				{ prefixedName: "mcp__demo__get_unique_table", resourceUri: "demo://unique" },
			]);
			expect(resolveCodemodeTools(config, cache)).toEqual(first);
			expect(takeSkippedDirectTools()).toEqual(["demo_get_unique_table"]);
			// Raw console output clogs the TUI prompt.
			expect(warn).toHaveBeenCalledTimes(0);
		} finally {
			warn.mockRestore();
		}
	});
});

describe("metadata cache hashing", () => {
	it("hashes interpolated cwd", () => {
		process.env.MCP_HASH_CWD = "/tmp/mcp-one";
		const first = computeServerHash({ command: "node", cwd: `\${MCP_HASH_CWD}/server` });

		process.env.MCP_HASH_CWD = "/tmp/mcp-two";
		const second = computeServerHash({ command: "node", cwd: `\${MCP_HASH_CWD}/server` });

		expect(first).not.toBe(second);
		expect(computeServerHash({ command: "node", cwd: `\${MCP_HASH_CWD}/server` })).toBe(
			computeServerHash({ command: "node", cwd: "/tmp/mcp-two/server" }),
		);
	});

	it("hashes interpolated env values", () => {
		process.env.MCP_HASH_ENV = "/tmp/data-one";
		const first = computeServerHash({ command: "node", env: { DATA_DIR: `\${MCP_HASH_ENV}` } });

		process.env.MCP_HASH_ENV = "/tmp/data-two";
		const second = computeServerHash({ command: "node", env: { DATA_DIR: `\${MCP_HASH_ENV}` } });

		expect(first).not.toBe(second);
		expect(computeServerHash({ command: "node", env: { DATA_DIR: `\${MCP_HASH_ENV}` } })).toBe(
			computeServerHash({ command: "node", env: { DATA_DIR: "/tmp/data-two" } }),
		);
	});

	it("hashes interpolated header values", () => {
		process.env.MCP_HASH_HEADER = "header-one";
		const first = computeServerHash({
			url: "https://example.test/mcp",
			headers: { "x-root": "$env:MCP_HASH_HEADER" },
		});

		process.env.MCP_HASH_HEADER = "header-two";
		const second = computeServerHash({
			url: "https://example.test/mcp",
			headers: { "x-root": "$env:MCP_HASH_HEADER" },
		});

		expect(first).not.toBe(second);
		expect(
			computeServerHash({
				url: "https://example.test/mcp",
				headers: { "x-root": "$env:MCP_HASH_HEADER" },
			}),
		).toBe(
			computeServerHash({ url: "https://example.test/mcp", headers: { "x-root": "header-two" } }),
		);
	});

	it("hashes tilde cwd as the home directory", () => {
		expect(computeServerHash({ command: "node", cwd: "~/server" })).toBe(
			computeServerHash({ command: "node", cwd: join(homedir(), "server") }),
		);
	});

	it("hashes the effective bearerTokenEnv value", () => {
		process.env.MCP_HASH_TOKEN = "token-one";
		const first = computeServerHash({
			url: "https://example.test/mcp",
			auth: "bearer",
			bearerTokenEnv: "MCP_HASH_TOKEN",
		});

		process.env.MCP_HASH_TOKEN = "token-two";
		const second = computeServerHash({
			url: "https://example.test/mcp",
			auth: "bearer",
			bearerTokenEnv: "MCP_HASH_TOKEN",
		});

		expect(first).not.toBe(second);
		expect(
			computeServerHash({
				url: "https://example.test/mcp",
				auth: "bearer",
				bearerTokenEnv: "MCP_HASH_TOKEN",
			}),
		).toBe(
			computeServerHash({
				url: "https://example.test/mcp",
				auth: "bearer",
				bearerToken: "token-two",
				bearerTokenEnv: "MCP_HASH_TOKEN",
			}),
		);
	});

	it("hashes interpolated bearerToken values", () => {
		process.env.MCP_HASH_TOKEN = "token-one";
		const first = computeServerHash({
			url: "https://example.test/mcp",
			auth: "bearer",
			bearerToken: `\${MCP_HASH_TOKEN}`,
		});

		process.env.MCP_HASH_TOKEN = "token-two";
		const second = computeServerHash({
			url: "https://example.test/mcp",
			auth: "bearer",
			bearerToken: `\${MCP_HASH_TOKEN}`,
		});

		expect(first).not.toBe(second);
		expect(
			computeServerHash({
				url: "https://example.test/mcp",
				auth: "bearer",
				bearerToken: "$env:MCP_HASH_TOKEN",
			}),
		).toBe(
			computeServerHash({
				url: "https://example.test/mcp",
				auth: "bearer",
				bearerToken: "token-two",
			}),
		);
	});

	it("invalidates cached metadata when an interpolated bearerToken env value changes", () => {
		const definition = {
			url: "https://example.test/mcp",
			auth: "bearer" as const,
			bearerToken: `\${MCP_HASH_TOKEN}`,
		};
		process.env.MCP_HASH_TOKEN = "token-one";
		const entry = {
			configHash: computeServerHash(definition),
			cachedAt: Date.now(),
			tools: [],
			resources: [],
		};

		expect(isServerCacheValid(entry, definition)).toBe(true);

		process.env.MCP_HASH_TOKEN = "token-two";

		expect(isServerCacheValid(entry, definition)).toBe(false);
	});
});

describe("excludeTools filtering", () => {
	it("filters excluded tools from live and cached metadata", () => {
		const definition = {
			command: "npx",
			args: ["-y", "figma"],
			excludeTools: ["figma_get_screenshot", "get_figjam"],
		};

		const { metadata } = buildToolMetadata(
			[
				{ name: "get_screenshot", description: "Screenshot" },
				{ name: "get_nodes", description: "Nodes" },
			] as any,
			[{ name: "figjam", uri: "ui://figjam", description: "FigJam" }] as any,
			definition,
			"figma",
			"server",
		);

		expect(metadata.map((tool) => tool.name)).toEqual(["figma_get_nodes"]);

		const reconstructed = reconstructToolMetadata(
			"figma",
			{
				configHash: computeServerHash(definition),
				cachedAt: Date.now(),
				tools: [
					{ name: "get_screenshot", description: "Screenshot" },
					{ name: "get_nodes", description: "Nodes" },
				],
				resources: [{ name: "figjam", uri: "ui://figjam", description: "FigJam" }],
			},
			"server",
			definition,
		);

		expect(reconstructed.map((tool) => tool.name)).toEqual(["figma_get_nodes"]);
	});

	it("filters excluded tools during direct tool registration from cache", () => {
		const config: McpConfig = {
			settings: { toolPrefix: "server" },
			mcpServers: {
				figma: {
					command: "npx",
					args: ["-y", "figma"],
					directTools: true,
					excludeTools: ["figma_get_screenshot", "get_figjam"],
				},
			},
		};

		const cache: MetadataCache = {
			version: 1,
			servers: {
				figma: {
					configHash: computeServerHash(config.mcpServers.figma),
					cachedAt: Date.now(),
					tools: [
						{ name: "get_screenshot", description: "Screenshot" },
						{ name: "get_nodes", description: "Nodes" },
					],
					resources: [{ name: "figjam", uri: "ui://figjam", description: "FigJam" }],
				},
			},
		};

		const specs = resolveDirectTools(config, cache, "server");

		expect(specs.map((spec) => spec.prefixedName)).toEqual(["figma_get_nodes"]);
	});

	it("exposes resource tools only when exposeResources is true", () => {
		const names = (exposeResources?: boolean) => {
			const definition = { command: "npx", directTools: true, exposeResources } as const;
			const cache: MetadataCache = {
				version: 1,
				servers: {
					db: {
						configHash: computeServerHash(definition),
						cachedAt: Date.now(),
						tools: [{ name: "query", description: "Query" }],
						resources: [{ name: "users", uri: "db://users", description: "Users" }],
					},
				},
			};
			const config: McpConfig = { mcpServers: { db: definition } };
			return resolveDirectTools(config, cache, "server").map((spec) => spec.prefixedName);
		};
		expect(names()).toEqual(["db_query"]);
		expect(names(true)).toEqual(["db_query", "db_get_users"]);
	});

	it("matches prefixed exclusions even when toolPrefix is none", () => {
		const config: McpConfig = {
			settings: { toolPrefix: "none" },
			mcpServers: {
				figma: {
					command: "npx",
					args: ["-y", "figma"],
					directTools: true,
					excludeTools: ["figma_get_screenshot"],
				},
			},
		};

		const cache: MetadataCache = {
			version: 1,
			servers: {
				figma: {
					configHash: computeServerHash(config.mcpServers.figma),
					cachedAt: Date.now(),
					tools: [
						{ name: "get_screenshot", description: "Screenshot" },
						{ name: "get_nodes", description: "Nodes" },
					],
					resources: [],
				},
			},
		};

		const specs = resolveDirectTools(config, cache, "none");

		expect(specs.map((spec) => spec.prefixedName)).toEqual(["get_nodes"]);
	});
});
