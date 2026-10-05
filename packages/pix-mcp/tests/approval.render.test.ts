import { expect, mock, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";
import type { McpExtensionState } from "../src/state.ts";

// ponytail: capture real MCP delete overlay and stock-dialog input bodies, not private host dialogs.
test("MCP approval surfaces show the delete diff and request disclosure", async () => {
	const fixture = await withUiFixture({ hostTheme: true });
	const theme = roleTheme();
	const captures: Record<string, string[]> = {};
	const panels: Array<{ dispose(): void; handleInput(data: string): void }> = [];
	const env = Object.fromEntries(
		["PI_CODING_AGENT_DIR", "MCP_OAUTH_DIR"].map((key) => [key, process.env[key]]),
	);
	let command: Promise<unknown> | undefined;
	let overlay: { handleInput(data: string): void } | undefined;
	const customResolvers = new Set<(value: unknown) => void>();
	const errors: unknown[] = [];
	let closing = false;
	try {
		process.env.PI_CODING_AGENT_DIR = fixture.agentDir;
		process.env.MCP_OAUTH_DIR = `${fixture.agentDir}/oauth`;
		const forbidden = () => {
			throw new Error("External action forbidden in approval capture");
		};
		const config = { mcpServers: { demo: { command: "never-run" } } };
		const configModule = await import("../src/config.ts");
		const remove = mock(() => {});
		mock.module("../src/config.ts", () => ({
			...configModule,
			loadMcpConfig: () => config,
			getServerProvenance: () => new Map([["demo", { kind: "user", path: "<agent>/mcp.json" }]]),
			getMcpDiscoverySummary: () => ({ hasSharedServers: false }),
			previewRemoveServerEntry: () => ({
				diffText:
					'--- before\n+++ after\n  {\n-   "demo": { "command": "never-run" }\n+   "mcpServers": {}\n  }',
			}),
			removeServerEntry: remove,
		}));
		const cacheModule = await import("../src/metadata-cache.ts");
		mock.module("../src/metadata-cache.ts", () => ({
			...cacheModule,
			loadMetadataCache: () => null,
		}));
		mock.module("../src/init.ts", () => ({
			getFailureAgeSeconds: () => null,
			lazyConnect: forbidden,
			updateMetadataCache: forbidden,
			updateStatusBar: forbidden,
		}));
		mock.module("../src/mcp-auth-flow.ts", () => ({
			authenticate: forbidden,
			removeAuth: async () => {},
			supportsOAuth: () => false,
		}));
		mock.module("open", () => ({ default: forbidden }));
		const { openMcpPanel } = await import("../src/commands.ts");
		let ready!: () => void;
		const opened = new Promise<void>((resolve) => {
			ready = resolve;
		});
		let count = 0;
		const ui = {
			theme,
			notify() {},
			custom: (create: any, options: unknown) =>
				new Promise((done) => {
					customResolvers.add(done);
					const component = create(
						{ requestRender() {}, terminal: { rows: 30 } },
						theme,
						undefined,
						done,
					);
					expect(options).toMatchObject({ overlay: true });
					if (closing) {
						panels.push(component);
						component.handleInput("\x1b");
					} else if (count++ === 0) {
						panels.push(component);
						component.handleInput("\x1b[B");
						component.handleInput("\x04");
					} else {
						overlay = component;
						captures["delete-selected"] = captureRows(component, {
							width: 80,
							surface: "component",
						});
						component.handleInput("\x1b[B");
						captures["cancel-selected"] = captureRows(component, {
							width: 80,
							surface: "component",
						});
						component.handleInput("\x1b[A");
						ready();
					}
				}),
		};
		command = openMcpPanel(
			{ config, manager: { getConnection: () => undefined } } as unknown as McpExtensionState,
			{ getFlag: () => undefined } as never,
			{ hasUI: true, cwd: fixture.agentDir, ui } as unknown as ExtensionContext,
		);
		// Observe rejection now. Cleanup still awaits and reports the original command error.
		void command.catch(() => {});
		await opened;
		expect(remove).toHaveBeenCalledTimes(0);
		overlay!.handleInput("\r");
		expect(await command).toEqual({ configChanged: true });
		command = undefined;
		expect(remove).toHaveBeenCalledWith("<agent>/mcp.json", "demo");
		const { handleElicitationRequest } = await import("../src/elicitation-handler.ts");
		const prompts: string[] = [];
		const selection = ["Continue", "Enter value", "Submit"];
		const inputUi = {
			select: async (title: string, choices: string[]) => {
				prompts.push(title);
				captures[`elicitation-${prompts.length}`] = captureRows(
					new Text(`${title}\n\n${choices.join(" · ")}`, 0, 0),
					{ width: 80, surface: "component" },
				);
				return selection.shift();
			},
			input: async () => "records",
			notify: forbidden,
		};
		expect(
			await handleElicitationRequest(
				{ serverName: "demo", allowUrl: false, ui: inputUi as never },
				{
					method: "elicitation/create",
					params: {
						mode: "form",
						message: "Choose a query",
						requestedSchema: {
							type: "object",
							properties: { query: { type: "string" } },
							required: ["query"],
						},
					},
				},
			),
		).toEqual({ action: "accept", content: { query: "records" } });
		inputUi.select = async (title, choices) => {
			captures["browser-request-body"] = captureRows(
				new Text(`${title}\n\n${choices.join(" · ")}`, 0, 0),
				{ width: 80, surface: "component" },
			);
			return "Decline";
		};
		expect(
			await handleElicitationRequest(
				{ serverName: "demo", allowUrl: true, ui: inputUi as never },
				{
					method: "elicitation/create",
					params: {
						mode: "url",
						message: "Connect the account",
						elicitationId: "fixture",
						url: "https://example.invalid/authorize?state=fixture",
					},
				},
			),
		).toEqual({ action: "decline" });
		const complete = mock(async () => ({
			role: "assistant",
			content: [{ type: "text", text: "Found records" }],
			provider: "fixture",
			model: "chosen",
			stopReason: "stop",
		}));
		mock.module("@earendil-works/pi-ai/compat", () => ({ complete }));
		const { handleSamplingRequest } = await import("../src/sampling-handler.ts");
		const model = { provider: "fixture", id: "chosen", name: "Chosen model" };
		let approvals = 0;
		const sampled = await handleSamplingRequest(
			{
				serverName: "demo",
				autoApprove: false,
				modelRegistry: {
					getAvailable: () => [model],
					getApiKeyAndHeaders: async () => ({ ok: true }),
				} as never,
				getCurrentModel: () => model as never,
				getSignal: () => undefined,
				ui: {
					confirm: async (title: string, body: string) => {
						captures[`sampling-${++approvals}`] = captureRows(
							new Text(`${title}\n\n${body}`, 0, 0),
							{ width: 80, surface: "component" },
						);
						expect(complete).toHaveBeenCalledTimes(approvals - 1);
						return true;
					},
				} as never,
			},
			{
				method: "sampling/createMessage",
				params: {
					systemPrompt: "Search records.",
					messages: [{ role: "user", content: { type: "text", text: "Find records" } }],
					maxTokens: 50,
				},
			},
		);
		expect(sampled).toMatchObject({
			model: "fixture/chosen",
			content: { type: "text", text: "Found records" },
		});
		expect(approvals).toBe(2);
		expect(captures).toMatchSnapshot();
	} catch (error) {
		errors.push(error);
	} finally {
		try {
			closing = true;
			if (command && overlay) {
				overlay.handleInput("\x1b[A");
				overlay.handleInput("\r");
			}
			if (command && !overlay) {
				for (const panel of panels) panel.handleInput("\x1b");
			}
			if (command) await command;
		} catch (error) {
			errors.push(error);
		} finally {
			try {
				for (const done of customResolvers) done(undefined);
				customResolvers.clear();
				for (const panel of panels) {
					try {
						panel.dispose();
					} catch (error) {
						errors.push(error);
					}
				}
			} catch (error) {
				errors.push(error);
			} finally {
				for (const [key, value] of Object.entries(env)) {
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
				}
				await fixture.restore().catch((error) => errors.push(error));
			}
		}
	}
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1)
		throw new AggregateError(errors, "MCP approval capture and cleanup failed");
});
