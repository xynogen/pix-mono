import { showTransientError, showTransientMessage } from "@xynogen/pix-pretty/transient-error";
import { getErrorMessage, pluralize } from "@xynogen/pix-pretty/utils";
import { registerPackageSettings } from "@xynogen/pix-runtime";
import type {
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionContext,
	ToolInfo,
} from "@xynogen/pix-runtime/host";
import { once } from "@xynogen/pix-runtime/once";
import { Type } from "typebox";
import { openMcpPanel } from "./commands.ts";
import { loadMcpConfig, takeUnsupportedConfigNotes } from "./config.ts";
import {
	buildProxyDescription,
	createDirectToolExecutor,
	getMissingConfiguredDirectToolServers,
	noteSkippedDirectTool,
	resolveCodemodeTools,
	resolveDirectTools,
	takeSkippedDirectTools,
} from "./direct-tools.ts";
import { toolErrorOverride } from "./error-signal.ts";
import { flushMetadataCache, initializeMcp, updateStatusBar } from "./init.ts";
import { logger, routeSdkDiagnostics } from "./logger.ts";
import { initializeOAuth, shutdownOAuth } from "./mcp-auth-flow.ts";
import { runMcpCommand } from "./mcp-command.ts";
import { loadMetadataCache } from "./metadata-cache.ts";
import { patchOutBuiltinMcp } from "./patch-builtin.ts";
import { type ProxyParams, parseProxyArgs, proxyParameters, runProxyMode } from "./proxy-tool.ts";
import type { McpExtensionState } from "./state.ts";
import { findToolByName } from "./tool-metadata.ts";
import {
	createMcpDirectToolCallRenderer,
	createMcpDirectToolResultRenderer,
	renderMcpProxyToolCall,
	renderMcpToolResult,
} from "./tool-result-renderer.ts";
import type { DirectToolSpec } from "./types.ts";
import { getConfigPathFromArgv, normalizeDirectToolInputSchema, truncateAtWord } from "./utils.ts";

// Raw console output clogs the TUI prompt. Batch skips into one transient warning.
// The transient slot shows the newest message only, so both notes share one line.
function reportSkippedDirectTools(ctx: ExtensionContext): void {
	const skipped = takeSkippedDirectTools();
	const ignored = takeUnsupportedConfigNotes();
	const parts = [
		...(skipped.length
			? [
					`skipped ${pluralize(skipped.length, "direct tool")} (name collision): ${skipped.join(", ")}`,
				]
			: []),
		...(ignored.length ? [`ignored mcp.json values: ${ignored.join(", ")}`] : []),
	];
	if (parts.length === 0) return;
	const message = `MCP: ${parts.join("; ")}`;
	if (ctx.hasUI) showTransientMessage(ctx.ui, message, "warning");
	else console.warn(message);
}

async function shutdownState(
	currentState: McpExtensionState | null,
	reason: string,
): Promise<void> {
	if (!currentState) return;

	if (currentState.uiServer) {
		currentState.uiServer.close(reason);
		currentState.uiServer = null;
	}

	let flushError: unknown;
	try {
		flushMetadataCache(currentState);
	} catch (error) {
		flushError = error;
	}

	try {
		await currentState.lifecycle.gracefulShutdown();
	} catch (error) {
		if (flushError) {
			logger.warn(
				`MCP: graceful shutdown failed after metadata flush error: ${getErrorMessage(error)}`,
			);
		} else {
			throw error;
		}
	}

	if (flushError) {
		throw flushError;
	}
}

export default function mcpAdapter(pi: ExtensionAPI) {
	once(pi, "pix-mcp", () => register(pi));
}

function register(pi: ExtensionAPI) {
	// The current load already replaced built-in MCP through the /mcp command.
	// Keep the same choice in settings for the next load without changing Pi's files.
	try {
		patchOutBuiltinMcp();
	} catch (error) {
		console.warn(`MCP: could not disable built-in MCP in settings: ${getErrorMessage(error)}`);
	}
	let state: McpExtensionState | null = null;
	let initPromise: Promise<McpExtensionState> | null = null;
	let lifecycleGeneration = 0;
	let removeLogHandler: (() => void) | undefined;
	let restoreSdkDiagnostics: (() => void) | undefined;

	const earlyConfigPath = getConfigPathFromArgv();
	const earlyConfig = loadMcpConfig(earlyConfigPath);
	const earlyCache = loadMetadataCache();
	const prefix = earlyConfig.settings?.toolPrefix ?? "server";
	const defaultDiscoveryLimit = earlyConfig.settings?.discoveryLimit;

	const envRaw = process.env.MCP_DIRECT_TOOLS;
	const directSpecs =
		envRaw === "__none__"
			? []
			: resolveDirectTools(
					earlyConfig,
					earlyCache,
					prefix,
					envRaw
						?.split(",")
						.map((s) => s.trim())
						.filter(Boolean),
				);
	const missingConfiguredDirectToolServers = getMissingConfiguredDirectToolServers(
		earlyConfig,
		earlyCache,
	);
	const shouldRegisterProxyTool =
		earlyConfig.settings?.disableProxyTool !== true ||
		directSpecs.length === 0 ||
		missingConfiguredDirectToolServers.length > 0;

	const registeredDirectNames = new Set<string>();
	let liveDirectSpecs = new Map<string, DirectToolSpec>();

	function syncDirectTools(specs: DirectToolSpec[], codemodeSpecs: DirectToolSpec[] = []) {
		const codemodeNames = new Set(codemodeSpecs.map((spec) => spec.prefixedName));
		const active = new Set(pi.getActiveTools());
		const otherNames = new Set(
			pi
				.getAllTools()
				.filter((tool) => !registeredDirectNames.has(tool.name))
				.map((tool) => tool.name),
		);
		const next = new Map<string, DirectToolSpec>();
		const generation = lifecycleGeneration;
		for (const spec of [...specs, ...codemodeSpecs]) {
			const name = spec.prefixedName;
			if (otherNames.has(name)) {
				noteSkippedDirectTool(name);
				continue;
			}
			const previous = liveDirectSpecs.get(name);
			if (previous && JSON.stringify(previous) === JSON.stringify(spec)) {
				next.set(name, previous);
				continue;
			}
			next.set(name, spec);
			const execute = createDirectToolExecutor(
				() => state,
				() => null,
				spec,
			);
			(pi.registerTool as (tool: unknown) => unknown)({
				name,
				label: `MCP: ${spec.originalName}`,
				description: spec.description || "(no description)",
				promptSnippet: truncateAtWord(spec.description, 100) || `MCP tool from ${spec.serverName}`,
				exposure: codemodeNames.has(name) ? "deferred" : "direct",
				namespace: codemodeNames.has(name)
					? {
							name: spec.serverName,
							...(spec.serverDescription ? { description: spec.serverDescription } : {}),
							...(spec.serverInstructions ? { instructions: spec.serverInstructions } : {}),
						}
					: undefined,
				parameters: Type.Unsafe(normalizeDirectToolInputSchema(spec.inputSchema)),
				async execute(...args: Parameters<typeof execute>) {
					if (generation !== lifecycleGeneration)
						throw new Error(`MCP tool "${name}" belongs to a stale session`);
					if (initPromise) await initPromise;
					if (generation !== lifecycleGeneration || !state || liveDirectSpecs.get(name) !== spec) {
						throw new Error(
							`MCP tool "${name}" is no longer available; rediscover tools before retrying`,
						);
					}
					return execute(...args);
				},
				renderShell: "self",
				renderCall: createMcpDirectToolCallRenderer(
					`mcp ${spec.originalName} @ ${spec.serverName}`,
				),
				renderResult: createMcpDirectToolResultRenderer(
					`mcp ${spec.originalName} @ ${spec.serverName}`,
				),
			});
			if (!registeredDirectNames.has(name) && !codemodeNames.has(name)) active.add(name);
			registeredDirectNames.add(name);
		}
		liveDirectSpecs = next;
		// ponytail: Pi has no unregisterTool; deactivate tombstones and reject stale executors.
		// Remove registrations too when the host adds an unregister API.
		pi.setActiveTools(
			[...active].filter(
				(name) => !codemodeNames.has(name) && (!registeredDirectNames.has(name) || next.has(name)),
			),
		);
	}

	function refreshDirectTools(currentState: McpExtensionState) {
		syncDirectTools(
			envRaw === "__none__"
				? []
				: resolveDirectTools(
						currentState.config,
						loadMetadataCache(),
						currentState.config.settings?.toolPrefix ?? "server",
						envRaw
							?.split(",")
							.map((s) => s.trim())
							.filter(Boolean),
					),
			resolveCodemodeTools(currentState.config, loadMetadataCache()),
		);
	}

	const getPiTools = (): ToolInfo[] => pi.getAllTools();

	pi.registerFlag("mcp-config", {
		description: "Path to MCP config file",
		type: "string",
	});

	pi.on("session_start", async (_event, ctx) => {
		removeLogHandler?.();
		restoreSdkDiagnostics?.();
		logger.setConsoleOutput(!ctx.hasUI);
		removeLogHandler = ctx.hasUI
			? logger.addHandler((entry) => {
					if (entry.level !== "warn" && entry.level !== "error") return;
					const message = entry.error
						? `${entry.message}: ${getErrorMessage(entry.error)}`
						: entry.message;
					showTransientMessage(ctx.ui, message, entry.level === "warn" ? "warning" : "error");
				})
			: undefined;
		restoreSdkDiagnostics = ctx.hasUI ? routeSdkDiagnostics() : undefined;
		const generation = ++lifecycleGeneration;
		const previousState = state;
		if (previousState) previousState.onToolMetadataChanged = undefined;
		state = null;
		initPromise = null;
		liveDirectSpecs.clear();
		// Tool inventory APIs are unavailable during factory loading.
		syncDirectTools(directSpecs, resolveCodemodeTools(earlyConfig, earlyCache));
		reportSkippedDirectTools(ctx);

		try {
			await Promise.all([shutdownState(previousState, "session_restart"), shutdownOAuth()]);
		} catch (error) {
			logger.warn(`MCP: failed to shut down previous session state: ${getErrorMessage(error)}`);
		}

		if (generation !== lifecycleGeneration) {
			return;
		}

		await initializeOAuth().catch((error) => {
			const detail = getErrorMessage(error);
			if (ctx.hasUI)
				showTransientMessage(ctx.ui, `MCP OAuth initialization failed: ${detail}`, "warning");
		});

		if (generation !== lifecycleGeneration) return;
		const promise = initializeMcp(pi, ctx);
		initPromise = promise;

		promise
			.then(async (nextState) => {
				if (generation !== lifecycleGeneration || initPromise !== promise) {
					try {
						await shutdownState(nextState, "stale_session_start");
					} catch (error) {
						logger.warn(`MCP: failed to clean stale session state: ${getErrorMessage(error)}`);
					}
					return;
				}

				state = nextState;
				nextState.onToolMetadataChanged = () => {
					if (generation !== lifecycleGeneration || state !== nextState) return;
					refreshDirectTools(nextState);
					reportSkippedDirectTools(ctx);
				};
				nextState.onToolMetadataChanged();
				updateStatusBar(nextState);
				initPromise = null;
			})
			.catch((err) => {
				if (generation !== lifecycleGeneration) {
					return;
				}
				if (initPromise !== promise && initPromise !== null) {
					return;
				}
				const detail = getErrorMessage(err);
				if (ctx.hasUI) showTransientError(ctx.ui, `MCP initialization failed: ${detail}`);
				initPromise = null;
			});
	});

	pi.on("session_shutdown", async () => {
		++lifecycleGeneration;
		const currentState = state;
		if (currentState) currentState.onToolMetadataChanged = undefined;
		state = null;
		initPromise = null;
		liveDirectSpecs.clear();

		try {
			await Promise.all([shutdownState(currentState, "session_shutdown"), shutdownOAuth()]);
		} catch (error) {
			logger.warn(`MCP: session shutdown cleanup failed: ${getErrorMessage(error)}`);
		} finally {
			removeLogHandler?.();
			removeLogHandler = undefined;
			restoreSdkDiagnostics?.();
			restoreSdkDiagnostics = undefined;
			logger.setConsoleOutput(true);
		}
	});

	// Re-flag returned MCP tool failures so pi registers them as errors (see toolErrorOverride).
	pi.on("tool_result", (event) => toolErrorOverride(event.details));

	registerPackageSettings(pi, {
		id: "pix-mcp",
		label: "MCP",
		open: async (ctx) => {
			if (!state && initPromise) state = await initPromise;
			if (!state) throw new Error("MCP not initialized");
			const result = await openMcpPanel(state, pi, ctx, earlyConfigPath);
			if (result?.configChanged) await ctx.reload();
		},
	});

	pi.registerCommand("mcp", {
		description: "Show MCP server status",
		handler: async (args, ctx) => {
			if (!state && initPromise) {
				try {
					state = await initPromise;
				} catch (error) {
					const message = getErrorMessage(error);
					if (ctx.hasUI) ctx.ui.notify(`MCP initialization failed: ${message}`, "error");
					return;
				}
			}
			if (!state) {
				if (ctx.hasUI) ctx.ui.notify("MCP not initialized", "error");
				return;
			}
			await runMcpCommand(args, state, pi, ctx, earlyConfigPath);
		},
	});

	if (shouldRegisterProxyTool) {
		(pi.registerTool as (tool: unknown) => unknown)({
			name: "mcp",
			label: "MCP",
			description: buildProxyDescription(earlyConfig, earlyCache, directSpecs),
			promptSnippet: "Discover and call configured MCP tools on demand",
			renderShell: "self",
			renderCall: (...[args, theme, context]: Parameters<typeof renderMcpProxyToolCall>) => {
				for (const [server, metadata] of state?.toolMetadata ?? []) {
					if (args.server && args.server !== server) continue;
					const tool = args.tool ? findToolByName(metadata, args.tool) : undefined;
					if (tool) {
						return renderMcpProxyToolCall(
							{ ...args, tool: tool.originalName, server },
							theme,
							context,
						);
					}
				}
				return renderMcpProxyToolCall(args, theme, context);
			},
			parameters: proxyParameters,
			renderResult: renderMcpToolResult,
			async execute(
				_toolCallId: string,
				params: ProxyParams,
				signal: AbortSignal | undefined,
				_onUpdate: AgentToolUpdateCallback<Record<string, unknown>> | undefined,
				_ctx: ExtensionContext,
			) {
				const parsedArgs = parseProxyArgs(params.args);
				if (!state && initPromise) {
					try {
						state = await initPromise;
					} catch (error) {
						const message = getErrorMessage(error);
						return {
							content: [{ type: "text" as const, text: `MCP initialization failed: ${message}` }],
							details: { error: "init_failed", message },
						};
					}
				}
				if (!state) {
					return {
						content: [{ type: "text" as const, text: "MCP not initialized" }],
						details: { error: "not_initialized" },
					};
				}
				return runProxyMode(state, params, parsedArgs, {
					signal,
					getPiTools,
					defaultDiscoveryLimit,
				});
			},
		});
	}
}
