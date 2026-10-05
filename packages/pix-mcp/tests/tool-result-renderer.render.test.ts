import { expect, mock, test } from "bun:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { collapseSection } from "@xynogen/pix-runtime/sections";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";
import type { McpExtensionState } from "../src/state.ts";

// ponytail: registered renderer shells, not the private full-screen host component.
test("registered MCP gateway and direct tools use the host Box", async () => {
	const fixture = await withUiFixture({ hostTheme: true });
	const env = Object.fromEntries(
		["MCP_DIRECT_TOOLS", "MCP_OUTPUT_GUARD", "MCP_OAUTH_DIR", "FORCE_COLOR", "NO_COLOR"].map(
			(key) => [key, process.env[key]],
		),
	);
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, (...args: any[]) => any>();
	let highlight: typeof import("@xynogen/pix-pretty/highlight") | undefined;
	let savedCache: Map<string, string[]> | undefined;
	const errors: unknown[] = [];
	try {
		delete process.env.MCP_DIRECT_TOOLS;
		process.env.MCP_OUTPUT_GUARD = "0";
		process.env.MCP_OAUTH_DIR = `${fixture.agentDir}/oauth`;
		process.env.FORCE_COLOR = "3";
		delete process.env.NO_COLOR;
		const config = {
			settings: { toolPrefix: "server" as const },
			mcpServers: { demo: { command: "never-run", directTools: true } },
		};
		const forbiddenCommand = () => {
			throw new Error("Management command forbidden in tool capture");
		};
		const schema = { type: "object", properties: { query: { type: "string" } } };
		let payload: Record<string, unknown> = { content: [{ type: "text", text: "done" }] };
		const callTool = mock(async () => payload);
		const state = {
			config,
			manager: {
				getConnection: () => ({ status: "connected", client: { callTool } }),
				getAllConnections: () => new Map(),
				touch() {},
				incrementInFlight() {},
				decrementInFlight() {},
				connect: () => {
					throw new Error("Live connect forbidden");
				},
			},
			toolMetadata: new Map([
				[
					"demo",
					[
						{
							name: "demo_search",
							originalName: "search",
							description: "Find records",
							inputSchema: schema,
						},
					],
				],
			]),
			failureTracker: new Map(),
			completedUiSessions: [],
			uiServer: null,
			lifecycle: { gracefulShutdown: async () => {} },
		} as unknown as McpExtensionState;
		mock.module("../src/patch-builtin.ts", () => ({ patchOutBuiltinMcp: () => false }));
		mock.module("../src/config.ts", () => ({
			loadMcpConfig: () => config,
			takeUnsupportedConfigNotes: () => [],
		}));
		mock.module("../src/commands.ts", () => ({
			logoutServer: forbiddenCommand,
			openMcpPanel: forbiddenCommand,
			openMcpSetup: forbiddenCommand,
			reconnectServers: forbiddenCommand,
			showStatus: forbiddenCommand,
			showTools: forbiddenCommand,
		}));
		const cacheModule = await import("../src/metadata-cache.ts");
		mock.module("../src/metadata-cache.ts", () => ({
			...cacheModule,
			loadMetadataCache: () => ({
				version: 1,
				servers: {
					demo: {
						configHash: cacheModule.computeServerHash(config.mcpServers.demo),
						cachedAt: Date.now(),
						tools: [{ name: "search", description: "Find records", inputSchema: schema }],
						resources: [],
					},
				},
			}),
		}));
		mock.module("../src/init.ts", () => ({
			initializeMcp: async () => state,
			lazyConnect: async () => true,
			getFailureAgeSeconds: () => null,
			flushMetadataCache() {},
			updateStatusBar() {},
			updateServerMetadata() {},
			updateMetadataCache() {},
		}));
		const forbidden = () => {
			throw new Error("Live OAuth forbidden");
		};
		mock.module("../src/mcp-auth-flow.ts", () => ({
			initializeOAuth: async () => {},
			shutdownOAuth: async () => {},
			authenticate: forbidden,
			startAuth: forbidden,
			completeAuthFromInput: forbidden,
			supportsOAuth: () => false,
			removeAuth: forbidden,
		}));
		highlight = await import("@xynogen/pix-pretty/highlight");
		savedCache = new Map(highlight._cache);
		highlight._cache.clear();
		const { default: register } = await import("../src/index.ts");
		register({
			registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
			registerFlag() {},
			registerCommand() {},
			on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
			getAllTools: () => [...tools.values()],
			getActiveTools: () => [...tools.keys()],
			setActiveTools() {},
		} as unknown as ExtensionAPI);
		await handlers.get("session_start")?.({}, { hasUI: false });
		const gateway = tools.get("mcp")!;
		const direct = tools.get("demo_search")!;
		expect([gateway.name, direct.name]).toEqual(["mcp", "demo_search"]);
		expect(gateway).not.toHaveProperty("renderShell");
		expect(direct).not.toHaveProperty("renderShell");
		const theme = roleTheme();
		const captures: Record<string, string[]> = {};
		async function card(
			name: string,
			tool: ToolDefinition,
			args: Record<string, unknown>,
			result: any,
			options = { expanded: false, isPartial: false },
			collapsed = false,
		) {
			const context = {
				state: { collapsed },
				expanded: options.expanded,
				isError: Boolean(result.details?.error),
				invalidate: () => {},
			};
			const call = () => tool.renderCall!(args, theme as never, context as never);
			const output = () => tool.renderResult!(result, options, theme as never, context as never);
			// Await the renderer's actual highlight completion, never a guessed delay.
			for (const render of [call, output]) {
				let resolve!: () => void;
				const completed = new Promise<void>((done) => {
					resolve = done;
				});
				context.invalidate = resolve;
				render();
				const slots = (context.state as any)._highlights ?? {};
				if (Object.values(slots).some((slot: any) => slot.text === undefined)) await completed;
			}
			const content = new Box(0, 0);
			content.addChild(call());
			content.addChild(output());
			captures[name] = captureRows(content, { width: 80, surface: "host-box" });
		}
		const result = await gateway.execute(
			"capture",
			{ tool: "demo_search", args: '{"query":"records"}' },
			undefined,
			undefined,
			{} as never,
		);
		expect(result.content).toEqual([{ type: "text", text: "done" }]);
		await card(
			"proxy-success",
			gateway,
			{ tool: "demo_search", args: '{"query":"records"}' },
			result,
		);
		await card(
			"direct-success",
			direct,
			{},
			await direct.execute("capture", {}, undefined, undefined, {} as never),
		);
		await card("partial", gateway, { tool: "demo_search" }, result, {
			expanded: false,
			isPartial: true,
		});
		payload = { isError: true, content: [{ type: "text", text: "upstream failed\nretry later" }] };
		const failed = await direct.execute("capture", {}, undefined, undefined, {} as never);
		expect(failed.details).toMatchObject({ error: "tool_error" });
		await card("direct-error", direct, {}, failed);
		await card("proxy-error-expanded", gateway, {}, failed, { expanded: true, isPartial: false });
		for (const [name, args] of Object.entries({
			status: {},
			search: { search: "records" },
			list: { server: "demo" },
			describe: { describe: "demo_search" },
		})) {
			await card(
				name,
				gateway,
				args,
				await gateway.execute("capture", args, undefined, undefined, {} as never),
			);
		}
		const plain = (text: string) => ({
			content: [{ type: "text" as const, text }],
			details: { tool: "search", server: "demo" },
		});
		await card("empty", gateway, {}, { content: [], details: {} });
		await card(
			"image",
			gateway,
			{},
			{ content: [{ type: "image", data: "abcd", mimeType: "image/png" }], details: {} },
		);
		await card("long-preview", direct, {}, plain(JSON.stringify({ value: "x".repeat(100) })));
		await card("long-expanded", direct, {}, plain(JSON.stringify({ value: "x".repeat(100) })), {
			expanded: true,
			isPartial: false,
		});
		await card("toon-json", direct, {}, plain("ok: true\nrows[1]{name,count}:\n  records,2"));
		await card("unsupported-toon", direct, {}, plain("nested:\n  child: true"));
		await card(
			"truncated-preview-with-hint",
			gateway,
			{},
			plain(Array.from({ length: 81 }, (_, index) => `row ${index + 1}`).join("\n")),
		);
		const { formatMcpToolResultLines } = await import("../src/tool-result-renderer.ts");
		const capped = formatMcpToolResultLines(plain("one\ntwo\nthree\nfour\nfive"), false, 3);
		expect(capped).toEqual({ lines: ["one", "two", "three", "… +2 more"], truncated: true });
		captures["format-preview-cap"] = captureRows(new Text(capped.lines.join("\n"), 0, 0), {
			width: 80,
			surface: "component",
		});
		await fixture.runtime.update(collapseSection, (current) => ({
			...current,
			enabled: true,
			tools: {},
		}));
		await card(
			"proxy-collapsed",
			gateway,
			{ tool: "demo_search" },
			plain("one\ntwo"),
			undefined,
			true,
		);
		await card("direct-collapsed", direct, {}, plain("one\ntwo"), undefined, true);
		await card(
			"direct-reexpanded",
			direct,
			{},
			plain("one\ntwo"),
			{ expanded: true, isPartial: false },
			true,
		);
		expect(captures).toMatchSnapshot();
	} catch (error) {
		errors.push(error);
	} finally {
		try {
			await handlers.get("session_shutdown")?.();
		} catch (error) {
			errors.push(error);
		} finally {
			try {
				tools.clear();
				handlers.clear();
				if (highlight && savedCache) {
					highlight._cache.clear();
					for (const [key, value] of savedCache) highlight._cache.set(key, value);
				}
				for (const [key, value] of Object.entries(env)) {
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
				}
			} catch (error) {
				errors.push(error);
			} finally {
				await fixture.restore().catch((error) => errors.push(error));
			}
		}
	}
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, "MCP tool capture and cleanup failed");
});
