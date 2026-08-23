import type { AgentToolResult, ToolInfo } from "@earendil-works/pi-coding-agent";
import { UrlElicitationRequiredError } from "@modelcontextprotocol/client";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { padIcon } from "@xynogen/pix-pretty/utils";
import { checkSync } from "recheck";
import { abortable, throwIfAborted } from "./abort.ts";
import {
	getFailureAgeSeconds,
	lazyConnect,
	updateMetadataCache,
	updateServerMetadata,
	updateStatusBar,
} from "./init.ts";
import { authenticate, completeAuthFromInput, startAuth, supportsOAuth } from "./mcp-auth-flow.ts";
import {
	guardedMcpDetails,
	guardMcpOutput,
	resolveMcpOutputGuardOptions,
} from "./mcp-output-guard.ts";
import type { McpExtensionState } from "./state.ts";
import { buildToolMetadata, findToolByName, formatSchema, getToolNames } from "./tool-metadata.ts";
import { resolveMcpResultContent, transformMcpContent } from "./tool-registrar.ts";
import type { McpContent, ToolMetadata } from "./types.ts";
import { getServerPrefix, parseUiPromptHandoff } from "./types.ts";
import { maybeStartUiSession, type UiSessionRuntime } from "./ui-session.ts";
import { formatAuthRequiredMessage, truncateAtWord } from "./utils.ts";

type ProxyToolResult = AgentToolResult<Record<string, unknown>>;

const MAX_REGEX_SEARCH_QUERY_LENGTH = 256;
const DEFAULT_DISCOVERY_LIMIT = 12;
const MAX_DISCOVERY_LIMIT = 50;
const REGEX_SAFETY_CHECK_PARAMS = {
	attackTimeout: 50,
	incubationTimeout: 50,
	timeout: 250,
} as const;

type AutoAuthResult =
	| { status: "skipped" }
	| { status: "success" }
	| { status: "failed"; message: string };

function getAuthRequiredMessage(
	state: McpExtensionState,
	serverName: string,
	defaultMessage = `Server "${serverName}" requires OAuth authentication. Run mcp({ action: "auth-start", server: "${serverName}" }) to get a browser URL, or open /mcp and select the server in an interactive local session.`,
): string {
	return formatAuthRequiredMessage(state.config, serverName, defaultMessage);
}

function getAuthFailedMessage(
	state: McpExtensionState,
	serverName: string,
	message: string,
): string {
	const customGuidance = state.config.settings?.authRequiredMessage;
	if (customGuidance) {
		return `OAuth authentication failed for "${serverName}": ${message}. ${getAuthRequiredMessage(state, serverName)}`;
	}
	return `OAuth authentication failed for "${serverName}": ${message}. Run mcp({ action: "auth-start", server: "${serverName}" }) to get a browser URL, or open /mcp and select the server in an interactive local session.`;
}

function getRedirectPort(authorizationUrl: string): number | undefined {
	try {
		const redirectUri = new URL(authorizationUrl).searchParams.get("redirect_uri");
		if (!redirectUri) return undefined;
		const port = Number.parseInt(new URL(redirectUri).port, 10);
		return Number.isInteger(port) ? port : undefined;
	} catch {
		return undefined;
	}
}

function formatManualAuthInstructions(serverName: string, authorizationUrl: string): string {
	const port = getRedirectPort(authorizationUrl);
	const portNote = port
		? `\nThe redirect URL will use local port ${port}. On a remote server it is expected for that localhost page to fail locally; copy the address bar URL anyway.`
		: "";

	return [
		`MCP OAuth required for "${serverName}".`,
		"",
		"Open this URL in your local browser:",
		"",
		authorizationUrl,
		"",
		"After approving, copy the full redirected localhost URL from your browser address bar and send it back with:",
		`mcp({ action: "auth-complete", server: "${serverName}", args: '{"redirectUrl":"PASTE_REDIRECT_URL_HERE"}' })`,
		"",
		'You can also pass just the `code` query parameter as `args: \'{"code":"PASTE_CODE_HERE"}\'`.',
		portNote.trimEnd(),
	]
		.filter(Boolean)
		.join("\n");
}

async function attemptAutoAuth(
	state: McpExtensionState,
	serverName: string,
): Promise<AutoAuthResult> {
	if (state.config.settings?.autoAuth !== true) {
		return { status: "skipped" };
	}

	const definition = state.config.mcpServers[serverName];
	if (!definition || !supportsOAuth(definition) || !definition.url) {
		return { status: "skipped" };
	}

	const grantType = definition.oauth
		? (definition.oauth.grantType ?? "authorization_code")
		: "authorization_code";
	if (!state.ui && grantType !== "client_credentials") {
		return {
			status: "failed",
			message: getAuthRequiredMessage(
				state,
				serverName,
				`Server "${serverName}" requires OAuth authentication. Run mcp({ action: "auth-start", server: "${serverName}" }) to get a browser URL, or open /mcp and select the server in an interactive local session.`,
			),
		};
	}

	try {
		await authenticate(serverName, definition.url, definition);
		return { status: "success" };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			status: "failed",
			message: getAuthFailedMessage(state, serverName, message),
		};
	}
}

export function executeUiMessages(state: McpExtensionState): ProxyToolResult {
	const sessions = state.completedUiSessions;

	if (sessions.length === 0) {
		return {
			content: [{ type: "text" as const, text: "No UI session messages available." }],
			details: { sessions: 0 },
		};
	}

	const output: string[] = [];
	output.push(
		`UI Session Messages (${sessions.length} session${sessions.length > 1 ? "s" : ""}):\n`,
	);

	const allPrompts: string[] = [];
	const allIntents = sessions.flatMap((session) => session.messages.intents);
	const parsedHandoffs: Array<{ intent: string; params: Record<string, unknown>; raw: string }> =
		[];

	for (const session of sessions) {
		const timestamp = session.completedAt.toLocaleTimeString();
		output.push(
			`\n## ${session.serverName} / ${session.toolName} (${timestamp}, ${session.reason})`,
		);

		const plainPrompts: string[] = [];
		for (const prompt of session.messages.prompts) {
			allPrompts.push(prompt);
			const handoff = parseUiPromptHandoff(prompt);
			if (handoff) {
				parsedHandoffs.push(handoff);
			} else {
				plainPrompts.push(prompt);
			}
		}

		if (plainPrompts.length > 0) {
			output.push("\n### Prompts:");
			for (const prompt of plainPrompts) {
				output.push(`- ${prompt}`);
			}
		}

		const intentsForSession = [
			...session.messages.intents,
			...session.messages.prompts
				.map((prompt) => parseUiPromptHandoff(prompt))
				.filter((handoff): handoff is NonNullable<typeof handoff> => !!handoff)
				.map((handoff) => ({ intent: handoff.intent, params: handoff.params })),
		];

		if (intentsForSession.length > 0) {
			output.push("\n### Intents:");
			for (const intent of intentsForSession) {
				const params = intent.params ? ` (${JSON.stringify(intent.params)})` : "";
				output.push(`- ${intent.intent}${params}`);
			}
		}

		if (session.messages.notifications.length > 0) {
			output.push("\n### Notifications:");
			for (const notification of session.messages.notifications) {
				output.push(`- ${notification}`);
			}
		}
	}

	const count = sessions.length;
	state.completedUiSessions = [];

	return {
		content: [{ type: "text" as const, text: output.join("\n") }],
		details: {
			sessions: count,
			prompts: allPrompts,
			intents: [...allIntents, ...parsedHandoffs.map(({ intent, params }) => ({ intent, params }))],
			handoffs: parsedHandoffs,
			cleared: true,
		},
	};
}

export function executeStatus(state: McpExtensionState): ProxyToolResult {
	const servers: Array<{
		name: string;
		status: string;
		toolCount: number;
		failedAgo: number | null;
	}> = [];

	for (const name of Object.keys(state.config.mcpServers)) {
		const connection = state.manager.getConnection(name);
		const metadata = state.toolMetadata.get(name);
		const toolCount = metadata?.length ?? 0;
		const failedAgo = getFailureAgeSeconds(state, name);
		let status = "not connected";
		if (connection?.status === "connected") {
			status = "connected";
		} else if (connection?.status === "needs-auth") {
			status = "needs-auth";
		} else if (failedAgo !== null) {
			status = "failed";
		} else if (metadata !== undefined) {
			status = "cached";
		}

		servers.push({ name, status, toolCount, failedAgo });
	}

	const totalTools = servers.reduce((sum, s) => sum + s.toolCount, 0);
	const connectedCount = servers.filter((s) => s.status === "connected").length;

	let text = `MCP: ${connectedCount}/${servers.length} servers, ${totalTools} tools\n\n`;
	for (const server of servers) {
		// padIcon normalizes 1-cell markers vs 2-cell `⚠` (status.warn) to one column.
		if (server.status === "connected") {
			text += `${padIcon(icon("status.ok"))} ${server.name} (${server.toolCount} tools)\n`;
			continue;
		}
		if (server.status === "needs-auth") {
			text += `${padIcon(icon("status.warn"))} ${server.name} (needs auth)\n`;
			continue;
		}
		if (server.status === "cached") {
			text += `${padIcon(icon("status.pending"))} ${server.name} (${server.toolCount} tools, cached)\n`;
			continue;
		}
		if (server.status === "failed") {
			text += `${padIcon(icon("status.error"))} ${server.name} (failed ${server.failedAgo ?? 0}s ago)\n`;
			continue;
		}
		text += `${padIcon(icon("status.pending"))} ${server.name} (not connected)\n`;
	}

	if (servers.length > 0) {
		text += `\nmcp({ server: "name" }) to list tools, mcp({ search: "..." }) to search`;
	}

	return {
		content: [{ type: "text" as const, text: text.trim() }],
		details: { mode: "status", servers, totalTools, connectedCount },
	};
}

export async function executeAuthStart(
	state: McpExtensionState,
	serverName: string,
): Promise<ProxyToolResult> {
	const definition = state.config.mcpServers[serverName];
	if (!definition) {
		return {
			content: [
				{
					type: "text" as const,
					text: `Server "${serverName}" not found. Use mcp({}) to see available servers.`,
				},
			],
			details: { mode: "auth-start", error: "not_found", server: serverName },
		};
	}

	if (!definition.url || !supportsOAuth(definition)) {
		return {
			content: [
				{
					type: "text" as const,
					text: `Server "${serverName}" is not configured for OAuth over HTTP.`,
				},
			],
			details: { mode: "auth-start", error: "oauth_not_supported", server: serverName },
		};
	}

	try {
		const { authorizationUrl, callbackCompletion } = await startAuth(
			serverName,
			definition.url,
			definition,
			{ waitForBrowserCallback: true },
		);
		if (!authorizationUrl) {
			return {
				content: [
					{ type: "text" as const, text: `OAuth authentication successful for "${serverName}".` },
				],
				details: { mode: "auth-start", server: serverName, authenticated: true },
			};
		}

		void callbackCompletion
			?.then(async () => {
				await state.manager.close(serverName);
				state.failureTracker.delete(serverName);
				updateStatusBar(state);
			})
			.catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				state.ui?.notify(`OAuth callback failed for "${serverName}": ${message}`, "error");
			});

		return {
			content: [
				{ type: "text" as const, text: formatManualAuthInstructions(serverName, authorizationUrl) },
			],
			details: { mode: "auth-start", server: serverName, authorizationUrl },
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [
				{ type: "text" as const, text: `Failed to start OAuth for "${serverName}": ${message}` },
			],
			details: { mode: "auth-start", error: "auth_start_failed", server: serverName, message },
		};
	}
}

export async function executeAuthComplete(
	state: McpExtensionState,
	serverName: string,
	input: string,
): Promise<ProxyToolResult> {
	if (!state.config.mcpServers[serverName]) {
		return {
			content: [
				{
					type: "text" as const,
					text: `Server "${serverName}" not found. Use mcp({}) to see available servers.`,
				},
			],
			details: { mode: "auth-complete", error: "not_found", server: serverName },
		};
	}

	try {
		const status = await completeAuthFromInput(serverName, input);
		if (status !== "authenticated") {
			return {
				content: [
					{
						type: "text" as const,
						text: `OAuth authentication did not complete for "${serverName}".`,
					},
				],
				details: { mode: "auth-complete", error: "not_authenticated", server: serverName, status },
			};
		}

		await state.manager.close(serverName);
		state.failureTracker.delete(serverName);
		updateStatusBar(state);
		return {
			content: [
				{
					type: "text" as const,
					text: `OAuth authentication successful for "${serverName}". Run mcp({ connect: "${serverName}" }) to connect with the new token.`,
				},
			],
			details: { mode: "auth-complete", server: serverName, authenticated: true },
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [
				{ type: "text" as const, text: `Failed to complete OAuth for "${serverName}": ${message}` },
			],
			details: {
				mode: "auth-complete",
				error: "auth_complete_failed",
				server: serverName,
				message,
			},
		};
	}
}

export function executeDescribe(state: McpExtensionState, toolName: string): ProxyToolResult {
	let serverName: string | undefined;
	let toolMeta: ToolMetadata | undefined;

	for (const [server, metadata] of state.toolMetadata.entries()) {
		const found = findToolByName(metadata, toolName);
		if (found) {
			serverName = server;
			toolMeta = found;
			break;
		}
	}

	if (!serverName || !toolMeta) {
		return {
			content: [
				{
					type: "text" as const,
					text: `Tool "${toolName}" not found. Use mcp({ search: "..." }) to search.`,
				},
			],
			details: { mode: "describe", error: "tool_not_found", requestedTool: toolName },
		};
	}

	let text = `${toolMeta.name}\n`;
	text += `Server: ${serverName}\n`;
	if (toolMeta.resourceUri) {
		text += `Type: Resource (reads from ${toolMeta.resourceUri})\n`;
	}
	text += `\n${toolMeta.description || "(no description)"}\n`;

	if (toolMeta.inputSchema && !toolMeta.resourceUri) {
		text += `\nParameters:\n${formatSchema(toolMeta.inputSchema)}`;
	} else if (toolMeta.resourceUri) {
		text += `\nNo parameters required (resource tool).`;
	} else {
		text += `\nNo parameters defined.`;
	}

	return {
		content: [{ type: "text" as const, text: text.trim() }],
		details: { mode: "describe", tool: toolMeta, server: serverName },
	};
}

export function executeSearch(
	state: McpExtensionState,
	query: string,
	regex?: boolean,
	server?: string,
	includeSchemas?: boolean,
	limit?: number,
): ProxyToolResult {
	const showSchemas = includeSchemas === true;
	const resultLimit = normalizeDiscoveryLimit(limit ?? state.config.settings?.discoveryLimit);

	const matches: Array<{ server: string; tool: ToolMetadata }> = [];

	let pattern: RegExp;
	try {
		if (regex) {
			if (query.length > MAX_REGEX_SEARCH_QUERY_LENGTH) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Regex query is too long; maximum length is ${MAX_REGEX_SEARCH_QUERY_LENGTH} characters.`,
						},
					],
					details: {
						mode: "search",
						error: "query_too_long",
						query,
						maxLength: MAX_REGEX_SEARCH_QUERY_LENGTH,
					},
				};
			}

			pattern = new RegExp(query, "i");
			let safety: ReturnType<typeof checkSync>;
			try {
				safety = checkSync(query, "i", REGEX_SAFETY_CHECK_PARAMS);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [
						{ type: "text" as const, text: "Regex query rejected because safety analysis failed." },
					],
					details: { mode: "search", error: "unsafe_pattern", query, reason: message },
				};
			}
			if (safety.status !== "safe") {
				return {
					content: [
						{ type: "text" as const, text: `Regex query rejected as unsafe (${safety.status}).` },
					],
					details: { mode: "search", error: "unsafe_pattern", query, safetyStatus: safety.status },
				};
			}
		} else {
			const terms = query
				.trim()
				.split(/\s+/)
				.filter((t) => t.length > 0);
			if (terms.length === 0) {
				return {
					content: [{ type: "text" as const, text: "Search query cannot be empty" }],
					details: { mode: "search", error: "empty_query" },
				};
			}
			const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
			pattern = new RegExp(escaped.join("|"), "i");
		}
	} catch {
		return {
			content: [{ type: "text" as const, text: `Invalid regex: ${query}` }],
			details: { mode: "search", error: "invalid_pattern", query },
		};
	}

	for (const [serverName, metadata] of state.toolMetadata.entries()) {
		if (server && serverName !== server) continue;
		for (const tool of metadata) {
			if (pattern.test(tool.name) || pattern.test(tool.description)) {
				matches.push({
					server: serverName,
					tool,
				});
			}
		}
	}

	const totalCount = matches.length;

	if (totalCount === 0) {
		const msg = server
			? `No tools matching "${query}" in "${server}"`
			: `No tools matching "${query}"`;
		return {
			content: [{ type: "text" as const, text: msg }],
			details: { mode: "search", matches: [], count: 0, query },
		};
	}

	const visibleMatches = matches.slice(0, resultLimit);
	const omittedCount = totalCount - visibleMatches.length;
	let text = `${totalCount} match${totalCount === 1 ? "" : "es"} for "${query}"`;
	if (omittedCount > 0) text += ` (showing ${visibleMatches.length})`;
	text += ":\n";

	for (const match of visibleMatches) {
		if (showSchemas) {
			text += `\n${match.tool.name}\n`;
			text += `${match.tool.description || "(no description)"}\n`;
			if (match.tool.inputSchema && !match.tool.resourceUri) {
				text += `Parameters:\n${formatSchema(match.tool.inputSchema, "  ")}\n`;
			} else if (match.tool.resourceUri) {
				text += `  No parameters (resource tool).\n`;
			}
		} else {
			text += `- ${match.tool.name}`;
			if (match.tool.description) {
				text += ` - ${truncateAtWord(match.tool.description, 50)}`;
			}
			text += "\n";
		}
	}

	if (omittedCount > 0) {
		text += `\n${omittedCount} omitted; refine search or raise limit (max ${MAX_DISCOVERY_LIMIT}).`;
	}
	if (!showSchemas) {
		text += `\nUse mcp({ describe: "tool_name" }) for one schema.`;
	}

	return {
		content: [{ type: "text" as const, text: text.trim() }],
		details: {
			mode: "search",
			matches: visibleMatches.map((m) => ({ server: m.server, tool: m.tool.name })),
			count: totalCount,
			returned: visibleMatches.length,
			omitted: omittedCount,
			query,
		},
	};
}

export function executeList(
	state: McpExtensionState,
	server: string,
	limit?: number,
): ProxyToolResult {
	if (!state.config.mcpServers[server]) {
		return {
			content: [
				{
					type: "text" as const,
					text: `Server "${server}" not found. Use mcp({}) to see available servers.`,
				},
			],
			details: { mode: "list", server, tools: [], count: 0, error: "not_found" },
		};
	}

	const metadata = state.toolMetadata.get(server);
	const toolNames = metadata?.map((m) => m.name) ?? [];
	const connection = state.manager.getConnection(server);

	if (toolNames.length === 0) {
		if (connection?.status === "connected") {
			return {
				content: [{ type: "text" as const, text: `Server "${server}" has no tools.` }],
				details: { mode: "list", server, tools: [], count: 0 },
			};
		}
		if (metadata !== undefined) {
			return {
				content: [
					{
						type: "text" as const,
						text: `Server "${server}" has no cached tools (not connected).`,
					},
				],
				details: { mode: "list", server, tools: [], count: 0, cached: true },
			};
		}
		return {
			content: [
				{
					type: "text" as const,
					text: `Server "${server}" is configured but not connected. Use mcp({ connect: "${server}" }) or /mcp reconnect ${server} to retry.`,
				},
			],
			details: { mode: "list", server, tools: [], count: 0, error: "not_connected" },
		};
	}

	const resultLimit = normalizeDiscoveryLimit(limit ?? state.config.settings?.discoveryLimit);
	const visibleToolNames = toolNames.slice(0, resultLimit);
	const omittedCount = toolNames.length - visibleToolNames.length;
	const cachedNote = connection?.status === "connected" ? "" : ", cached";
	let text = `${server}: ${toolNames.length} tools${cachedNote}`;
	if (omittedCount > 0) text += ` (showing ${visibleToolNames.length})`;
	text += "\n";

	const descMap = new Map<string, string>();
	if (metadata) {
		for (const m of metadata) {
			descMap.set(m.name, m.description);
		}
	}

	for (const tool of visibleToolNames) {
		const desc = descMap.get(tool) ?? "";
		const truncated = truncateAtWord(desc, 50);
		text += `- ${tool}`;
		if (truncated) text += ` - ${truncated}`;
		text += "\n";
	}

	if (omittedCount > 0) {
		text += `${omittedCount} omitted; refine with search or raise limit (max ${MAX_DISCOVERY_LIMIT}).\n`;
	}

	return {
		content: [{ type: "text" as const, text: text.trim() }],
		details: {
			mode: "list",
			server,
			tools: visibleToolNames,
			count: toolNames.length,
			returned: visibleToolNames.length,
			omitted: omittedCount,
		},
	};
}

function normalizeDiscoveryLimit(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_DISCOVERY_LIMIT;
	return Math.min(MAX_DISCOVERY_LIMIT, Math.max(1, Math.trunc(value)));
}

export async function executeConnect(
	state: McpExtensionState,
	serverName: string,
	signal?: AbortSignal,
): Promise<ProxyToolResult> {
	throwIfAborted(signal);
	const definition = state.config.mcpServers[serverName];
	if (!definition) {
		return {
			content: [
				{
					type: "text" as const,
					text: `Server "${serverName}" not found. Use mcp({}) to see available servers.`,
				},
			],
			details: { mode: "connect", error: "not_found", server: serverName },
		};
	}

	try {
		if (state.ui) {
			state.ui.setStatus("mcp", `MCP: connecting to ${serverName}...`);
		}
		let connection = await state.manager.connect(serverName, definition, signal);
		if (connection.status === "needs-auth") {
			const autoAuth = await attemptAutoAuth(state, serverName);
			if (autoAuth.status === "failed") {
				return {
					content: [{ type: "text" as const, text: autoAuth.message }],
					details: {
						mode: "connect",
						error: "auth_required",
						server: serverName,
						message: autoAuth.message,
					},
				};
			}
			if (autoAuth.status === "success") {
				await state.manager.close(serverName);
				connection = await state.manager.connect(serverName, definition, signal);
			}
			if (connection.status === "needs-auth") {
				const message = getAuthRequiredMessage(state, serverName);
				return {
					content: [{ type: "text" as const, text: message }],
					details: { mode: "connect", error: "auth_required", server: serverName, message },
				};
			}
		}
		const prefix = state.config.settings?.toolPrefix ?? "server";
		const { metadata } = buildToolMetadata(
			connection.tools,
			connection.resources,
			definition,
			serverName,
			prefix,
		);
		state.toolMetadata.set(serverName, metadata);
		updateMetadataCache(state, serverName);
		state.failureTracker.delete(serverName);
		updateStatusBar(state);
		return executeList(state, serverName);
	} catch (error) {
		if (!signal?.aborted) {
			state.failureTracker.set(serverName, Date.now());
		}
		updateStatusBar(state);
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [
				{ type: "text" as const, text: `Failed to connect to "${serverName}": ${message}` },
			],
			details: {
				mode: "connect",
				error: signal?.aborted ? "aborted" : "connect_failed",
				server: serverName,
				message,
			},
		};
	}
}

// ── executeCall decomposition ───────────────────────────────────────────────
//
// executeCall is split into three phases so each function stays small enough
// to reason about (and under the cognitive-complexity budget):
//   1. resolveCallTarget   — find the server/tool metadata for the request
//   2. ensureCallConnection — make sure the server connection is usable
//   3. performToolCall      — run the tool/resource call and guard the output

type Connection = NonNullable<ReturnType<McpExtensionState["manager"]["getConnection"]>>;
// SDK v2 dropped the result-schema arg from callTool; options are now arg[1].
type CallRequestOptions = Parameters<Connection["client"]["callTool"]>[1];

function authRequiredResult(state: McpExtensionState, serverName: string): ProxyToolResult {
	const message = getAuthRequiredMessage(state, serverName);
	return {
		content: [{ type: "text" as const, text: message }],
		details: { mode: "call", error: "auth_required", server: serverName, message },
	};
}

function autoAuthFailedResult(serverName: string, message: string): ProxyToolResult {
	return {
		content: [{ type: "text" as const, text: message }],
		details: { mode: "call", error: "auth_required", server: serverName, message },
	};
}

function serverBackoffResult(serverName: string, failedAgo: number): ProxyToolResult {
	return {
		content: [
			{
				type: "text" as const,
				text: `Server "${serverName}" not available (last failed ${failedAgo}s ago)`,
			},
		],
		details: { mode: "call", error: "server_backoff", server: serverName },
	};
}

function toolNotFoundAfterReconnectResult(
	state: McpExtensionState,
	serverName: string,
	toolName: string,
	withHint: boolean,
): ProxyToolResult {
	let hint = "";
	if (withHint) {
		const available = getToolNames(state, serverName);
		hint =
			available.length > 0
				? ` Available tools on "${serverName}": ${available.join(", ")}`
				: ` Server "${serverName}" has no tools.`;
	}
	return {
		content: [
			{
				type: "text" as const,
				text: `Tool "${toolName}" not found on "${serverName}" after reconnect.${hint}`,
			},
		],
		details: {
			mode: "call",
			error: "tool_not_found_after_reconnect",
			requestedTool: toolName,
		},
	};
}

type AutoAuthAttempt =
	| { kind: "authed" }
	| { kind: "skipped" }
	| { kind: "failed"; result: ProxyToolResult };

/**
 * Attempt auto-auth at most once per executeCall. On success the stale
 * connection is closed and the failure tracker cleared; the caller is
 * responsible for reconnecting. "skipped" means an attempt was already made
 * (or auto-auth did not apply), so the caller should re-check state.
 */
async function tryAutoAuth(
	state: McpExtensionState,
	serverName: string,
	attempted: { value: boolean },
): Promise<AutoAuthAttempt> {
	if (attempted.value) return { kind: "skipped" };
	attempted.value = true;
	const autoAuth = await attemptAutoAuth(state, serverName);
	if (autoAuth.status === "failed") {
		return { kind: "failed", result: autoAuthFailedResult(serverName, autoAuth.message) };
	}
	if (autoAuth.status === "success") {
		await state.manager.close(serverName);
		state.failureTracker.delete(serverName);
		return { kind: "authed" };
	}
	return { kind: "skipped" };
}

type TargetResolution =
	| { serverName: string; toolMeta: ToolMetadata }
	| { result: ProxyToolResult };

/** Lazy-connect an explicitly named server and locate the tool (site A). */
async function lazyConnectForTool(
	state: McpExtensionState,
	serverName: string,
	toolName: string,
	attempted: { value: boolean },
	signal?: AbortSignal,
): Promise<{ toolMeta: ToolMetadata | undefined } | { result: ProxyToolResult }> {
	const connected = await lazyConnect(state, serverName, signal);
	if (connected) {
		return { toolMeta: findToolByName(state.toolMetadata.get(serverName), toolName) };
	}

	let toolMeta: ToolMetadata | undefined;
	if (state.manager.getConnection(serverName)?.status === "needs-auth") {
		const attempt = await tryAutoAuth(state, serverName, attempted);
		if (attempt.kind === "failed") return { result: attempt.result };
		if (attempt.kind === "authed" && (await lazyConnect(state, serverName, signal))) {
			toolMeta = findToolByName(state.toolMetadata.get(serverName), toolName);
			if (!toolMeta) {
				return { result: toolNotFoundAfterReconnectResult(state, serverName, toolName, false) };
			}
			return { toolMeta };
		}
		if (state.manager.getConnection(serverName)?.status === "needs-auth") {
			return { result: authRequiredResult(state, serverName) };
		}
	}

	const failedAgo = getFailureAgeSeconds(state, serverName);
	if (failedAgo !== null) return { result: serverBackoffResult(serverName, failedAgo) };
	return { toolMeta: undefined };
}

type PrefixResolution =
	| { serverName?: string; toolMeta?: ToolMetadata; matchedServer?: string }
	| { result: ProxyToolResult };

/** Match `prefix_tool` names against configured servers (site B). */
async function resolveByToolPrefix(
	state: McpExtensionState,
	toolName: string,
	prefixMode: "server" | "none" | "short",
	attempted: { value: boolean },
	signal?: AbortSignal,
): Promise<PrefixResolution> {
	const candidates = Object.keys(state.config.mcpServers)
		.map((name) => ({ name, prefix: getServerPrefix(name, prefixMode) }))
		.filter((c) => c.prefix && toolName.startsWith(`${c.prefix}_`))
		.sort((a, b) => b.prefix.length - a.prefix.length);

	let matchedServer: string | undefined;
	for (const { name: configuredServer } of candidates) {
		const existingConnection = state.manager.getConnection(configuredServer);
		const failedAgo = getFailureAgeSeconds(state, configuredServer);
		if (failedAgo !== null && existingConnection?.status !== "needs-auth") continue;

		let connected = await lazyConnect(state, configuredServer, signal);
		if (!connected && state.manager.getConnection(configuredServer)?.status === "needs-auth") {
			const attempt = await tryAutoAuth(state, configuredServer, attempted);
			if (attempt.kind === "failed") return { result: attempt.result };
			if (attempt.kind === "authed") {
				connected = await lazyConnect(state, configuredServer, signal);
			}
		}

		if (!connected) continue;
		if (!matchedServer) matchedServer = configuredServer;
		const toolMeta = findToolByName(state.toolMetadata.get(configuredServer), toolName);
		if (toolMeta) {
			return { serverName: configuredServer, toolMeta, matchedServer };
		}
	}
	return { matchedServer };
}

function toolNotFoundResult(
	state: McpExtensionState,
	toolName: string,
	serverName: string | undefined,
	serverOverride: string | undefined,
	prefixMatchedServer: string | undefined,
	getPiTools: (() => ToolInfo[]) | undefined,
): ProxyToolResult {
	const nativeTool = !serverOverride
		? getPiTools?.().find((tool) => tool.name === toolName && tool.name !== "mcp")
		: undefined;
	if (nativeTool) {
		return {
			content: [
				{
					type: "text" as const,
					text: `"${toolName}" is a native Pi tool. Call ${toolName} directly instead of using mcp({ tool: "${toolName}" }).`,
				},
			],
			details: { mode: "call", error: "native_tool", requestedTool: toolName },
		};
	}

	const hintServer = serverName ?? prefixMatchedServer;
	const available = hintServer ? getToolNames(state, hintServer) : [];
	let msg = `Tool "${toolName}" not found.`;
	if (available.length > 0) {
		msg += ` Server "${hintServer}" has: ${available.join(", ")}`;
	} else {
		msg += ` Use mcp({ search: "..." }) to search.`;
	}
	return {
		content: [{ type: "text" as const, text: msg }],
		details: { mode: "call", error: "tool_not_found", requestedTool: toolName, hintServer },
	};
}

/** Phase 1: resolve the request to a concrete server + tool metadata. */
async function resolveCallTarget(
	state: McpExtensionState,
	toolName: string,
	serverOverride: string | undefined,
	getPiTools: (() => ToolInfo[]) | undefined,
	attempted: { value: boolean },
	signal?: AbortSignal,
): Promise<TargetResolution> {
	let serverName: string | undefined = serverOverride;
	let toolMeta: ToolMetadata | undefined;
	const prefixMode = state.config.settings?.toolPrefix ?? "server";

	if (serverName && !state.config.mcpServers[serverName]) {
		return {
			result: {
				content: [
					{
						type: "text" as const,
						text: `Server "${serverName}" not found. Use mcp({}) to see available servers.`,
					},
				],
				details: { mode: "call", error: "server_not_found", server: serverName },
			},
		};
	}

	if (serverName) {
		toolMeta = findToolByName(state.toolMetadata.get(serverName), toolName);
	} else {
		for (const [server, metadata] of state.toolMetadata.entries()) {
			const found = findToolByName(metadata, toolName);
			if (found) {
				serverName = server;
				toolMeta = found;
				break;
			}
		}
	}

	if (serverName && !toolMeta) {
		const lazy = await lazyConnectForTool(state, serverName, toolName, attempted, signal);
		if ("result" in lazy) return lazy;
		toolMeta = lazy.toolMeta;
	}

	let prefixMatchedServer: string | undefined;
	if (!serverName && !toolMeta && prefixMode !== "none") {
		const prefix = await resolveByToolPrefix(state, toolName, prefixMode, attempted, signal);
		if ("result" in prefix) return prefix;
		serverName = prefix.serverName;
		toolMeta = prefix.toolMeta;
		prefixMatchedServer = prefix.matchedServer;
	}

	if (serverName && toolMeta) return { serverName, toolMeta };
	return {
		result: toolNotFoundResult(
			state,
			toolName,
			serverName,
			serverOverride,
			prefixMatchedServer,
			getPiTools,
		),
	};
}

type ConnectionResolution =
	| { connection: Connection; toolMeta: ToolMetadata }
	| { result: ProxyToolResult };

/** Phase 2: ensure a connected, authenticated connection for the server. */
async function ensureCallConnection(
	state: McpExtensionState,
	serverName: string,
	toolName: string,
	toolMeta: ToolMetadata,
	attempted: { value: boolean },
	signal?: AbortSignal,
): Promise<ConnectionResolution> {
	let connection = state.manager.getConnection(serverName);
	if (connection?.status === "needs-auth") {
		const attempt = await tryAutoAuth(state, serverName, attempted);
		if (attempt.kind === "failed") return { result: attempt.result };
		if (attempt.kind === "authed") connection = state.manager.getConnection(serverName);
		if (connection?.status === "needs-auth") {
			return { result: authRequiredResult(state, serverName) };
		}
	}
	if (connection?.status === "connected") return { connection, toolMeta };

	const failedAgo = getFailureAgeSeconds(state, serverName);
	if (failedAgo !== null) return { result: serverBackoffResult(serverName, failedAgo) };

	const definition = state.config.mcpServers[serverName];
	if (!definition) {
		return {
			result: {
				content: [{ type: "text" as const, text: `Server "${serverName}" not connected` }],
				details: { mode: "call", error: "server_not_connected", server: serverName },
			},
		};
	}

	try {
		if (state.ui) {
			state.ui.setStatus("mcp", `MCP: connecting to ${serverName}...`);
		}
		connection = await state.manager.connect(serverName, definition, signal);
		if (connection.status === "needs-auth") {
			const attempt = await tryAutoAuth(state, serverName, attempted);
			if (attempt.kind === "failed") return { result: attempt.result };
			if (attempt.kind === "authed") {
				connection = await state.manager.connect(serverName, definition, signal);
			}
			if (connection.status === "needs-auth") {
				return { result: authRequiredResult(state, serverName) };
			}
		}
		state.failureTracker.delete(serverName);
		updateServerMetadata(state, serverName);
		updateMetadataCache(state, serverName);
		updateStatusBar(state);
		const refreshedMeta = findToolByName(state.toolMetadata.get(serverName), toolName);
		if (!refreshedMeta) {
			return { result: toolNotFoundAfterReconnectResult(state, serverName, toolName, true) };
		}
		return { connection, toolMeta: refreshedMeta };
	} catch (error) {
		if (!signal?.aborted) {
			state.failureTracker.set(serverName, Date.now());
		}
		updateStatusBar(state);
		const message = error instanceof Error ? error.message : String(error);
		return {
			result: {
				content: [
					{ type: "text" as const, text: `Failed to connect to "${serverName}": ${message}` },
				],
				details: { mode: "call", error: signal?.aborted ? "aborted" : "connect_failed", message },
			},
		};
	}
}

type GuardOptions = ReturnType<typeof resolveMcpOutputGuardOptions>;

/** Shared error-result shaping for tool calls (identical for UI and plain calls). */
async function buildToolErrorResult(
	toolMeta: ToolMetadata,
	result: Record<string, unknown>,
	outputGuardOptions: GuardOptions,
): Promise<ProxyToolResult> {
	const mcpContent = (result.content ?? []) as McpContent[];
	const content = transformMcpContent(mcpContent);
	const outputContent =
		content.length > 0 ? content : [{ type: "text" as const, text: "(empty result)" }];
	const schemaText = toolMeta.inputSchema
		? `\n\nExpected parameters:\n${formatSchema(toolMeta.inputSchema)}`
		: "";
	const guarded = await guardMcpOutput(outputContent, {
		...outputGuardOptions,
		prefix: "Error: ",
		suffix: schemaText,
		emptyTextFallback: "Tool execution failed",
		rawMcpResult: result,
	});
	return {
		content: guarded.content,
		details: { mode: "call", error: "tool_error", ...guardedMcpDetails(guarded) },
	};
}

/** Shared success-result shaping; `uiSuffix` marks a UI-backed call. */
async function buildToolSuccessResult(
	serverName: string,
	toolMeta: ToolMetadata,
	result: Record<string, unknown>,
	outputGuardOptions: GuardOptions,
	uiSuffix?: string,
): Promise<ProxyToolResult> {
	const content = resolveMcpResultContent(result);
	const outputContent =
		content.length > 0 ? content : [{ type: "text" as const, text: "(empty result)" }];
	const guarded = await guardMcpOutput(outputContent, {
		...outputGuardOptions,
		...(uiSuffix ? { suffix: uiSuffix } : {}),
		rawMcpResult: result,
	});
	return {
		content: guarded.content,
		details: {
			mode: "call",
			...guardedMcpDetails(guarded),
			server: serverName,
			tool: toolMeta.originalName,
			...(uiSuffix ? { uiOpen: true } : {}),
		},
	};
}

/** Read an MCP resource exposed through the proxy. */
async function performResourceRead(
	serverName: string,
	connection: Connection,
	resourceUri: string,
	requestOptions: CallRequestOptions,
	outputGuardOptions: GuardOptions,
): Promise<ProxyToolResult> {
	const result = await connection.client.readResource({ uri: resourceUri }, requestOptions);
	const content = (result.contents ?? []).map((c) => ({
		type: "text" as const,
		text:
			"text" in c
				? c.text
				: "blob" in c
					? `[Binary data: ${(c as { mimeType?: string }).mimeType ?? "unknown"}]`
					: JSON.stringify(c),
	}));
	const guarded = await guardMcpOutput(
		content.length > 0 ? content : [{ type: "text" as const, text: "(empty resource)" }],
		outputGuardOptions,
	);
	return {
		content: guarded.content,
		details: {
			mode: "call",
			resourceUri,
			server: serverName,
			...guardedMcpDetails(guarded),
		},
	};
}

/** Run the proxied callTool, including UI-session wiring. */
async function performClientCall(
	serverName: string,
	connection: Connection,
	toolMeta: ToolMetadata,
	args: Record<string, unknown> | undefined,
	requestOptions: CallRequestOptions,
	outputGuardOptions: GuardOptions,
	uiSession: UiSessionRuntime | null,
	signal?: AbortSignal,
): Promise<ProxyToolResult> {
	const resultPromise = connection.client.callTool(
		{
			name: toolMeta.originalName,
			arguments: args ?? {},
			_meta: uiSession?.requestMeta,
		},
		requestOptions,
	);
	const result = await abortable(resultPromise, signal);
	uiSession?.sendToolResult(
		result as unknown as import("@modelcontextprotocol/client").CallToolResult,
	);

	if (result.isError) {
		return buildToolErrorResult(toolMeta, result, outputGuardOptions);
	}

	const uiMessage = uiSession
		? uiSession.reused
			? "Updated the open UI."
			: "📺 Interactive UI is now open in your browser. I'll respond to your prompts and intents as you interact with it."
		: undefined;
	const suffix = uiMessage ? `\n\n${uiMessage}` : undefined;
	return buildToolSuccessResult(
		serverName,
		toolMeta,
		result as unknown as Record<string, unknown>,
		outputGuardOptions,
		suffix,
	);
}

/** Phase 3: execute the resolved tool/resource call and shape the output. */
async function performToolCall(
	state: McpExtensionState,
	serverName: string,
	connection: Connection,
	toolMeta: ToolMetadata,
	args: Record<string, unknown> | undefined,
	signal?: AbortSignal,
): Promise<ProxyToolResult> {
	let uiSession: UiSessionRuntime | null = null;
	const requestOptions =
		state.manager.getRequestOptions?.(serverName, signal) ?? (signal ? { signal } : undefined);
	const outputGuardOptions = resolveMcpOutputGuardOptions(state.config.settings);

	try {
		state.manager.touch(serverName);
		state.manager.incrementInFlight(serverName);

		if (toolMeta.resourceUri) {
			return await performResourceRead(
				serverName,
				connection,
				toolMeta.resourceUri,
				requestOptions,
				outputGuardOptions,
			);
		}

		uiSession = toolMeta.uiResourceUri
			? await maybeStartUiSession(state, {
					serverName,
					toolName: toolMeta.originalName,
					toolArgs: args ?? {},
					uiResourceUri: toolMeta.uiResourceUri,
					streamMode: toolMeta.uiStreamMode,
				})
			: null;

		return await performClientCall(
			serverName,
			connection,
			toolMeta,
			args,
			requestOptions,
			outputGuardOptions,
			uiSession,
			signal,
		);
	} catch (error) {
		if (error instanceof UrlElicitationRequiredError) {
			const action = await state.manager.handleUrlElicitationRequired(serverName, error);
			const message =
				action === "accept"
					? "The original MCP tool did not run. Complete the opened browser interaction, then retry the tool."
					: `The URL interaction was ${action === "decline" ? "declined" : "cancelled"}.`;
			uiSession?.sendToolCancelled(message);
			return {
				content: [{ type: "text" as const, text: message }],
				details: { mode: "call", error: "url_elicitation_required", server: serverName, action },
			};
		}
		const message = error instanceof Error ? error.message : String(error);
		uiSession?.sendToolCancelled(message);

		const schemaText = toolMeta.inputSchema
			? `\n\nExpected parameters:\n${formatSchema(toolMeta.inputSchema)}`
			: "";
		const guarded = await guardMcpOutput([{ type: "text" as const, text: message }], {
			...outputGuardOptions,
			prefix: "Failed to call tool: ",
			suffix: schemaText,
		});

		return {
			content: guarded.content,
			details: {
				mode: "call",
				error: "call_failed",
				message: guarded.outputGuard ? "output truncated; see outputGuard.fullOutputPath" : message,
				...guardedMcpDetails(guarded),
			},
		};
	} finally {
		if (uiSession?.reused) {
			uiSession.close();
		}
		state.manager.decrementInFlight(serverName);
		state.manager.touch(serverName);
	}
}

export async function executeCall(
	state: McpExtensionState,
	toolName: string,
	args?: Record<string, unknown>,
	serverOverride?: string,
	getPiTools?: () => ToolInfo[],
	signal?: AbortSignal,
): Promise<ProxyToolResult> {
	throwIfAborted(signal);
	const attempted = { value: false };

	const target = await resolveCallTarget(
		state,
		toolName,
		serverOverride,
		getPiTools,
		attempted,
		signal,
	);
	if ("result" in target) return target.result;

	const resolved = await ensureCallConnection(
		state,
		target.serverName,
		toolName,
		target.toolMeta,
		attempted,
		signal,
	);
	if ("result" in resolved) return resolved.result;

	return performToolCall(
		state,
		target.serverName,
		resolved.connection,
		resolved.toolMeta,
		args,
		signal,
	);
}
