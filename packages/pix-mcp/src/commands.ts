import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import {
	ensureCompatibilityImports,
	getMcpDiscoverySummary,
	getServerProvenance,
	isServerNameTaken,
	previewAddServerEntry,
	previewCompatibilityImports,
	previewSharedServerEntry,
	previewStarterProjectConfig,
	resolveAddTargetPath,
	writeAddServerEntry,
	writeDirectToolsConfig,
	writeSharedServerEntry,
	writeStarterProjectConfig,
} from "./config.ts";
import { getFailureAgeSeconds, lazyConnect, updateMetadataCache, updateStatusBar } from "./init.ts";
import { getAuthForUrl } from "./mcp-auth.ts";
import { authenticate, removeAuth, supportsOAuth } from "./mcp-auth-flow.ts";
import { loadMetadataCache } from "./metadata-cache.ts";
import {
	loadOnboardingState,
	markSharedConfigHintShown,
	markSetupCompleted as persistSetupCompleted,
} from "./onboarding-state.ts";
import type { McpExtensionState } from "./state.ts";
import { buildToolMetadata } from "./tool-metadata.ts";
import type {
	ImportKind,
	McpAuthResult,
	McpConfig,
	McpPanelCallbacks,
	McpPanelResult,
	ServerEntry,
} from "./types.ts";
import { openPath } from "./utils.ts";

export async function showStatus(state: McpExtensionState, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;

	const lines: string[] = ["MCP Server Status:", ""];

	for (const name of Object.keys(state.config.mcpServers)) {
		const connection = state.manager.getConnection(name);
		const metadata = state.toolMetadata.get(name);
		const toolCount = metadata?.length ?? 0;
		const failedAgo = getFailureAgeSeconds(state, name);
		let status = "not connected";
		let statusIcon = icon("status.pending");
		let failed = false;

		if (connection?.status === "connected") {
			status = "connected";
			statusIcon = icon("status.ok");
		} else if (connection?.status === "needs-auth") {
			status = "needs auth";
			statusIcon = icon("status.warn");
		} else if (failedAgo !== null) {
			status = `failed ${failedAgo}s ago`;
			statusIcon = icon("status.error");
			failed = true;
		} else if (metadata !== undefined) {
			status = "cached";
		}

		const toolSuffix = failed
			? ""
			: ` (${toolCount} tools${status === "cached" ? ", cached" : ""})`;
		lines.push(`${statusIcon} ${name}: ${status}${toolSuffix}`);
	}

	if (Object.keys(state.config.mcpServers).length === 0) {
		lines.push("No MCP servers configured");
		lines.push("Run /mcp setup to adopt imports or scaffold a starter .mcp.json");
	}

	ctx.ui.notify(lines.join("\n"), "info");
}

export async function showTools(state: McpExtensionState, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;

	const allTools = [...state.toolMetadata.values()].flat().map((m) => m.name);

	if (allTools.length === 0) {
		ctx.ui.notify("No MCP tools available", "info");
		return;
	}

	const lines = [
		"MCP Tools:",
		"",
		...allTools.map((t) => `  ${t}`),
		"",
		`Total: ${allTools.length} tools`,
	];

	ctx.ui.notify(lines.join("\n"), "info");
}

export async function reconnectServers(
	state: McpExtensionState,
	ctx: ExtensionContext,
	targetServer?: string,
): Promise<void> {
	if (targetServer && !state.config.mcpServers[targetServer]) {
		if (ctx.hasUI) {
			ctx.ui.notify(`Server "${targetServer}" not found in config`, "error");
		}
		return;
	}

	const entries = targetServer
		? [[targetServer, state.config.mcpServers[targetServer]] as [string, ServerEntry]]
		: Object.entries(state.config.mcpServers);

	for (const [name, definition] of entries) {
		try {
			await state.manager.close(name);

			const connection = await state.manager.connect(name, definition);
			if (connection.status === "needs-auth") {
				if (ctx.hasUI) {
					ctx.ui.notify(`MCP: ${name} requires OAuth. Open /mcp and select it.`, "warning");
				}
				continue;
			}
			const prefix = state.config.settings?.toolPrefix ?? "server";

			const { metadata, failedTools } = buildToolMetadata(
				connection.tools,
				connection.resources,
				definition,
				name,
				prefix,
			);
			state.toolMetadata.set(name, metadata);
			updateMetadataCache(state, name);
			state.failureTracker.delete(name);

			if (ctx.hasUI) {
				ctx.ui.notify(
					`MCP: Reconnected to ${name} (${connection.tools.length} tools, ${connection.resources.length} resources)`,
					"info",
				);
				if (failedTools.length > 0) {
					ctx.ui.notify(`MCP: ${name} - ${failedTools.length} tools skipped`, "warning");
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			state.failureTracker.set(name, Date.now());
			if (ctx.hasUI) {
				ctx.ui.notify(`MCP: Failed to reconnect to ${name}: ${message}`, "error");
			}
		}
	}

	updateStatusBar(state);
}

export async function authenticateServer(
	serverName: string,
	state: McpExtensionState,
	ctx: ExtensionContext,
): Promise<McpAuthResult> {
	if (!ctx.hasUI)
		return { ok: false, message: "OAuth authentication requires an interactive session." };

	const definition = state.config.mcpServers[serverName];
	if (!definition) {
		const message = `Server "${serverName}" not found in config`;
		ctx.ui.notify(message, "error");
		return { ok: false, message };
	}

	if (!supportsOAuth(definition)) {
		const message = `Server "${serverName}" does not use OAuth authentication. Set "auth": "oauth" or omit auth for auto-detection.`;
		ctx.ui.notify(
			`Server "${serverName}" does not use OAuth authentication.\n` +
				`Set "auth": "oauth" or omit auth for auto-detection.`,
			"error",
		);
		return { ok: false, message };
	}

	if (!definition.url) {
		const message = `Server "${serverName}" has no URL configured (OAuth requires HTTP transport)`;
		ctx.ui.notify(message, "error");
		return { ok: false, message };
	}

	try {
		ctx.ui.setStatus("mcp-auth", `Authenticating ${serverName}...`);
		const status = await authenticate(serverName, definition.url, definition, {
			onAuthorizationUrl: (authorizationUrl) => {
				ctx.ui.notify(
					`Open this URL to authenticate ${serverName}:\n\n${authorizationUrl}\n\n` +
						"After approving, return to Pi; the local callback will complete automatically.",
					"info",
				);
			},
		});

		if (status === "authenticated") {
			await state.manager.close(serverName);
			state.failureTracker.delete(serverName);
			const connected = await lazyConnect(state, serverName);
			if (!connected) {
				const message = `OAuth authentication succeeded for "${serverName}", but reconnect failed.`;
				ctx.ui.notify(message, "warning");
				return { ok: false, message };
			}

			const message = `OAuth authenticated and connected for "${serverName}".`;
			ctx.ui.notify(message, "info");
			return { ok: true, message };
		}

		const message = `OAuth authentication failed for "${serverName}".`;
		ctx.ui.notify(message, "error");
		return { ok: false, message };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Failed to authenticate "${serverName}": ${message}`, "error");
		return { ok: false, message };
	} finally {
		ctx.ui.setStatus("mcp-auth", undefined);
	}
}

export async function logoutServer(
	serverName: string,
	state: McpExtensionState,
	ctx: ExtensionContext,
): Promise<{ ok: boolean; message: string }> {
	const definition = state.config.mcpServers[serverName];
	if (!definition) {
		const message = `Server "${serverName}" not found in config`;
		if (ctx.hasUI) ctx.ui.notify(message, "error");
		return { ok: false, message };
	}

	await removeAuth(serverName);
	await state.manager.close(serverName);
	updateStatusBar(state);

	const message = `OAuth credentials cleared for "${serverName}". Open /mcp to authenticate again.`;
	if (ctx.hasUI) ctx.ui.notify(message, "info");
	return { ok: true, message };
}

export interface PanelFlowResult {
	configChanged: boolean;
}

function buildSharedConfigNoticeLines(
	configOverridePath: string | undefined,
	cwd: string,
): { lines: string[]; fingerprint: string | null } {
	const discovery = getMcpDiscoverySummary(configOverridePath, cwd);
	const onboardingState = loadOnboardingState();
	if (!discovery.hasSharedServers || onboardingState.sharedConfigHintShown) {
		return { lines: [], fingerprint: null };
	}

	const sharedSources = discovery.sources.filter(
		(source) => source.kind === "shared" && source.serverCount > 0,
	);
	const sourceList = sharedSources.map((source) => source.path).join(", ");
	return {
		lines: [
			`Using standard MCP config from ${sourceList}.`,
			"Pi only writes compatibility imports and adapter-specific overrides into Pi-owned files when needed.",
		],
		fingerprint: discovery.fingerprint,
	};
}

export async function openMcpSetup(
	_state: McpExtensionState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	configOverridePath?: string,
	mode: "empty" | "setup" = "setup",
): Promise<PanelFlowResult> {
	if (!ctx.hasUI) return { configChanged: false };

	const discovery = getMcpDiscoverySummary(configOverridePath, ctx.cwd);
	const onboardingState = loadOnboardingState();
	const { createMcpSetupPanel } = await import("./mcp-setup-panel.ts");
	let configChanged = false;

	const callbacks = {
		previewImports: (imports: ImportKind[]) =>
			previewCompatibilityImports(imports, configOverridePath),
		previewStarterProject: () => previewStarterProjectConfig(ctx.cwd),
		previewRepoPrompt: () => {
			const repoPrompt = getMcpDiscoverySummary(configOverridePath, ctx.cwd).repoPrompt;
			if (!repoPrompt.entry || !repoPrompt.targetPath || !repoPrompt.serverName) return null;
			return previewSharedServerEntry(
				repoPrompt.targetPath,
				repoPrompt.serverName,
				repoPrompt.entry,
			);
		},
		adoptImports: async (imports: ImportKind[]) => {
			const result = ensureCompatibilityImports(imports, configOverridePath);
			if (result.added.length > 0) configChanged = true;
			return result;
		},
		scaffoldProjectConfig: async () => {
			const path = writeStarterProjectConfig(ctx.cwd);
			configChanged = true;
			return { path };
		},
		addRepoPrompt: async () => {
			const repoPrompt = getMcpDiscoverySummary(configOverridePath, ctx.cwd).repoPrompt;
			if (!repoPrompt.entry || !repoPrompt.targetPath || !repoPrompt.serverName) {
				throw new Error("RepoPrompt is not available to add from this setup screen.");
			}
			const path = writeSharedServerEntry(
				repoPrompt.targetPath,
				repoPrompt.serverName,
				repoPrompt.entry,
			);
			configChanged = true;
			return { path, serverName: repoPrompt.serverName };
		},
		openPath: async (targetPath: string) => {
			await openPath(pi, targetPath);
		},
		markSetupCompleted: () => {
			persistSetupCompleted(discovery.fingerprint);
		},
	};

	return new Promise<PanelFlowResult>((resolve) => {
		ctx.ui.custom(
			(tui, theme, keybindings, done) => {
				return createMcpSetupPanel(
					discovery,
					callbacks,
					{ mode, onboardingState, keybindings },
					tui,
					() => {
						done(undefined);
						resolve({ configChanged });
					},
					theme,
				);
			},
			{ overlay: true, overlayOptions: { maxHeight: "80%" } },
		);
	});
}

function buildMcpPanelCallbacks(
	state: McpExtensionState,
	config: McpConfig,
	ctx: ExtensionContext,
): McpPanelCallbacks {
	return {
		reconnect: (serverName: string) => lazyConnect(state, serverName),
		canAuthenticate: (serverName: string) => {
			const definition = config.mcpServers[serverName];
			return definition ? supportsOAuth(definition) : false;
		},
		authenticate: (serverName: string) => authenticateServer(serverName, state, ctx),
		getConnectionStatus: (serverName: string) => {
			const definition = config.mcpServers[serverName];
			const connection = state.manager.getConnection(serverName);
			if (connection?.status === "needs-auth") {
				return "needs-auth";
			}
			if (
				definition?.auth === "oauth" &&
				definition.url &&
				definition.oauth !== false &&
				definition.oauth?.grantType !== "client_credentials" &&
				!getAuthForUrl(serverName, definition.url)?.tokens
			) {
				return "needs-auth";
			}
			if (connection?.status === "connected") return "connected";
			if (getFailureAgeSeconds(state, serverName) !== null) return "failed";
			return "idle";
		},
		refreshCacheAfterReconnect: (serverName: string) => {
			const freshCache = loadMetadataCache();
			return freshCache?.servers?.[serverName] ?? null;
		},
	};
}

async function openMcpAddOverlay(
	state: McpExtensionState,
	ctx: ExtensionContext,
	configOverridePath: string | undefined,
): Promise<import("./mcp-add-panel.ts").AddPanelResult> {
	const { createMcpAddPanel } = await import("./mcp-add-panel.ts");
	return new Promise<import("./mcp-add-panel.ts").AddPanelResult>((resolve) => {
		ctx.ui.custom(
			(tui, theme, keybindings, done) => {
				return createMcpAddPanel(
					{
						cwd: ctx.cwd,
						callbacks: {
							resolveTargetPath: (scope) => resolveAddTargetPath(scope, ctx.cwd),
							previewEntry: previewAddServerEntry,
							writeEntry: writeAddServerEntry,
							isNameTaken: (name) => isServerNameTaken(name, configOverridePath, ctx.cwd),
							testConnect: async (serverName) => {
								const ok = await lazyConnect(state, serverName);
								if (ok) return "connected";
								const conn = state.manager.getConnection(serverName);
								if (conn?.status === "needs-auth") return "needs-auth";
								return "failed";
							},
						},
					},
					tui,
					(result) => {
						done(undefined);
						resolve(result);
					},
					theme,
					keybindings,
				);
			},
			{ overlay: true, overlayOptions: { maxHeight: "80%" } },
		);
	});
}

export async function openMcpPanel(
	state: McpExtensionState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	configOverridePath?: string,
): Promise<PanelFlowResult> {
	if (Object.keys(state.config.mcpServers).length === 0) {
		return openMcpSetup(state, pi, ctx, configOverridePath, "empty");
	}

	const config = state.config;
	const cache = loadMetadataCache();
	const configPath = (pi.getFlag("mcp-config") as string | undefined) ?? configOverridePath;
	const provenanceMap = getServerProvenance(configPath, ctx.cwd);
	const { lines: noticeLines, fingerprint } = buildSharedConfigNoticeLines(configPath, ctx.cwd);

	const callbacks = buildMcpPanelCallbacks(state, config, ctx);

	const { createMcpPanel } = await import("./mcp-panel.ts");
	let configChanged = false;
	let wantsAdd = false;
	let addedServer: import("./mcp-add-panel.ts").AddPanelResult | undefined;

	await new Promise<void>((resolve) => {
		ctx.ui.custom(
			(tui, theme, keybindings, done) => {
				return createMcpPanel(
					config,
					cache,
					provenanceMap,
					callbacks,
					tui,
					(result: McpPanelResult) => {
						if (result.wantsAdd) {
							wantsAdd = true;
							done(undefined);
							resolve();
							return;
						}
						if (!result.cancelled && result.changes.size > 0) {
							writeDirectToolsConfig(result.changes, provenanceMap, config);
							configChanged = true;
							ctx.ui.notify(
								"Direct tools updated. Pi will reload after this panel closes.",
								"info",
							);
						}
						if (result.addedServer) {
							addedServer = result.addedServer;
							configChanged = true;
						}
						done(undefined);
						resolve();
					},
					{ noticeLines, keybindings, theme },
				);
			},
			{ overlay: true, overlayOptions: { maxHeight: "80%" } },
		);
	});

	if (wantsAdd) {
		const addResult = await openMcpAddOverlay(state, ctx, configOverridePath);
		if (!addResult.cancelled && addResult.configChanged) {
			const label =
				addResult.connectStatus === "connected"
					? "connected"
					: addResult.connectStatus === "needs-auth"
						? "needs auth"
						: (addResult.connectStatus ?? "failed");
			ctx.ui.notify(
				`Added ${addResult.serverName} to ${addResult.targetPath} — ${label}. Pi will reload.`,
				"info",
			);
			return { configChanged: true };
		}
		// cancelled add → return to panel
		return openMcpPanel(state, pi, ctx, configOverridePath);
	}

	if (addedServer) {
		const label =
			addedServer.connectStatus === "connected"
				? "connected"
				: addedServer.connectStatus === "needs-auth"
					? "needs auth"
					: (addedServer.connectStatus ?? "failed");
		ctx.ui.notify(
			`Added ${addedServer.serverName} to ${addedServer.targetPath} — ${label}.`,
			"info",
		);
	}

	if (noticeLines.length > 0 && fingerprint) {
		markSharedConfigHintShown(fingerprint);
	}

	return { configChanged: configChanged || !!addedServer };
}
