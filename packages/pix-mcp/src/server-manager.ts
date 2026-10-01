import type {
	Client,
	ReadResourceResult,
	RequestOptions,
	UrlElicitationRequiredError,
} from "@modelcontextprotocol/client";
import { getErrorMessage } from "@xynogen/pix-pretty/utils";
import { abortable, throwIfAborted } from "./abort.ts";
import { resolveConfigRecord, resolveOAuthSecret } from "./config-value.ts";
import {
	handleUrlElicitation,
	registerElicitationHandler,
	type ServerElicitationConfig,
} from "./elicitation-handler.ts";
import { logger } from "./logger.ts";
import { extractOAuthConfig, supportsOAuth } from "./mcp-auth-flow.ts";
import { loadSdk, loadStdio } from "./sdk.ts";

// A still-401 after the auth provider's retry means the server genuinely needs
// auth. SDK v1 threw UnauthorizedError; SDK v2 throws SdkHttpError{status:401}.
// Treat both as terminal auth failures (never fall through to SSE).
async function isUnauthorizedHttpError(error: unknown): Promise<boolean> {
	const { SdkHttpError, UnauthorizedError } = await loadSdk();
	return (
		error instanceof UnauthorizedError || (error instanceof SdkHttpError && error.status === 401)
	);
}

// Only a typed endpoint-shape mismatch means the server doesn't speak
// StreamableHTTP and SSE is worth trying. Any other error (403/500/network/
// protocol) is real and must propagate rather than be masked as "try SSE".
async function shouldFallbackToSse(error: unknown): Promise<boolean> {
	const { SdkHttpError } = await loadSdk();
	return error instanceof SdkHttpError && [404, 405, 406, 415].includes(error.status);
}

import { McpOAuthProvider } from "./mcp-oauth-provider.ts";
import { resolveNpxBinary } from "./npx-resolver.ts";
import { registerSamplingHandler, type ServerSamplingConfig } from "./sampling-handler.ts";
import type {
	McpResource,
	McpTool,
	ServerDefinition,
	ServerStreamResultPatchNotification,
	Transport,
} from "./types.ts";
import {
	SERVER_STREAM_RESULT_PATCH_METHOD,
	serverStreamResultPatchNotificationSchema,
} from "./types.ts";
import { resolveBearerToken, resolveConfigPath } from "./utils.ts";

// OAuth connects wait on a human browser round-trip (login, consent, redirect),
// which routinely runs far past the base request timeout. Scale connect/call
// timeouts 3× to cover it. Estimated, not config-exposed.
const REQUEST_TIMEOUT_FACTOR = 3;

interface ServerConnection {
	client: Client;
	transport: Transport;
	definition: ServerDefinition;
	tools: McpTool[];
	resources: McpResource[];
	lastUsedAt: number;
	inFlight: number;
	status: "connected" | "closed" | "needs-auth";
}

type UiStreamListener = (
	serverName: string,
	notification: ServerStreamResultPatchNotification["params"],
) => void;

export class McpServerManager {
	private connections = new Map<string, ServerConnection>();
	private connectPromises = new Map<string, Promise<ServerConnection>>();
	private uiStreamListeners = new Map<string, UiStreamListener>();
	private samplingConfig: ServerSamplingConfig | undefined;
	private providerToken: ((provider: string) => Promise<string | undefined>) | undefined;
	private elicitationConfig: ServerElicitationConfig | undefined;
	private acceptedUrlElicitations = new Map<string, Set<string>>();
	private defaultRequestTimeoutMs: number | undefined;
	private metadataChangedCallback: ((serverName: string) => void) | undefined;
	private connectingClients = new Map<string, Client>();
	private pendingListChanges = new Map<
		Client,
		Partial<{ tools: McpTool[]; resources: McpResource[] }>
	>();

	setMetadataChangedCallback(callback: ((serverName: string) => void) | undefined): void {
		this.metadataChangedCallback = callback;
	}

	/** Default cwd for stdio servers without an explicit config `cwd`. */
	constructor(private readonly defaultCwd?: string) {}

	/** Token source for `auth: { provider }` servers, usually Pi's model registry. */
	setProviderTokenResolver(
		resolver: ((provider: string) => Promise<string | undefined>) | undefined,
	): void {
		this.providerToken = resolver;
	}

	setSamplingConfig(config: ServerSamplingConfig | undefined): void {
		this.samplingConfig = config;
	}

	setElicitationConfig(config: ServerElicitationConfig | undefined): void {
		this.elicitationConfig = config;
	}

	setDefaultRequestTimeoutMs(timeoutMs: number | undefined): void {
		this.defaultRequestTimeoutMs = normalizeRequestTimeoutMs(timeoutMs);
	}

	getRequestOptions(name: string, signal?: AbortSignal): RequestOptions | undefined {
		const connection = this.connections.get(name);
		return this.buildRequestOptions(connection?.definition, signal);
	}

	private buildRequestOptions(
		definition?: ServerDefinition,
		signal?: AbortSignal,
	): RequestOptions | undefined {
		// A per-server `timeout` (seconds, Pi mcp.json) is exact. The shared base is
		// scaled 3× because slow servers routinely need more than the base wait.
		const serverMs = normalizeRequestTimeoutMs(
			typeof definition?.timeout === "number" ? definition.timeout * 1000 : undefined,
		);
		const base = this.defaultRequestTimeoutMs;
		const timeout = serverMs ?? (base !== undefined ? base * REQUEST_TIMEOUT_FACTOR : undefined);

		if (!signal && timeout === undefined) {
			return undefined;
		}

		return {
			...(signal ? { signal } : {}),
			...(timeout !== undefined ? { timeout } : {}),
		};
	}

	async connect(
		name: string,
		definition: ServerDefinition,
		signal?: AbortSignal,
	): Promise<ServerConnection> {
		throwIfAborted(signal);
		// Dedupe concurrent connection attempts
		if (this.connectPromises.has(name)) {
			return abortable(this.connectPromises.get(name)!, signal);
		}

		// Reuse existing connection if healthy
		const existing = this.connections.get(name);
		if (existing?.status === "connected") {
			existing.lastUsedAt = Date.now();
			return existing;
		}

		const promise = this.createConnection(name, definition, signal);
		this.connectPromises.set(name, promise);

		try {
			const connection = await promise;
			this.connections.set(name, connection);
			this.applyPendingListChanges(name, connection);
			return connection;
		} finally {
			this.connectPromises.delete(name);
			this.connectingClients.delete(name);
		}
	}

	private async createConnection(
		name: string,
		definition: ServerDefinition,
		signal?: AbortSignal,
	): Promise<ServerConnection> {
		throwIfAborted(signal);
		const client = await this.createClient(name);
		this.connectingClients.set(name, client);

		let transport: Transport;

		if (definition.command) {
			let command = definition.command;
			let args = definition.args ?? [];

			if (command === "npx" || command === "npm") {
				const resolved = await resolveNpxBinary(command, args);
				if (resolved) {
					command = resolved.isJs ? "node" : resolved.binPath;
					args = resolved.isJs ? [resolved.binPath, ...resolved.extraArgs] : resolved.extraArgs;
					logger.debug(`${name} resolved to ${resolved.binPath} (skipping npm parent)`);
				}
			}

			const { StdioClientTransport } = await loadStdio();
			transport = new StdioClientTransport({
				command,
				args,
				env: await resolveEnv(definition.env, name),
				cwd: resolveConfigPath(definition.cwd) ?? this.defaultCwd,
				stderr: definition.debug ? "inherit" : "ignore",
			});
		} else if (definition.url) {
			// HTTP transport with fallback
			transport = await this.createHttpTransport(definition, name, signal);
		} else {
			throw new Error(`Server ${name} has no command or url`);
		}

		const requestOptions = this.buildRequestOptions(definition, signal);
		const connection: ServerConnection = {
			client,
			transport,
			definition,
			tools: [],
			resources: [],
			lastUsedAt: Date.now(),
			inFlight: 0,
			status: "connected",
		};
		this.attachAdapterNotificationHandlers(name, client);

		try {
			await client.connect(transport, requestOptions);
			[connection.tools, connection.resources] = await Promise.all([
				this.fetchAllTools(client, requestOptions),
				this.fetchAllResources(client, requestOptions),
			]);
			if (connection.status === "closed") throw new Error(`Server ${name} closed during discovery`);
			return connection;
		} catch (error) {
			connection.status = "closed";
			// Check for a terminal 401 (UnauthorizedError or SdkHttpError) - server requires OAuth
			if ((await isUnauthorizedHttpError(error)) && supportsOAuth(definition)) {
				// Clean up both client and transport before reporting needs-auth.
				await client.close().catch(() => {});
				await transport.close().catch(() => {});

				return {
					client,
					transport,
					definition,
					tools: [],
					resources: [],
					lastUsedAt: Date.now(),
					inFlight: 0,
					status: "needs-auth",
				};
			}

			// Clean up both client and transport on any error
			await client.close().catch(() => {});
			await transport.close().catch(() => {});
			throw error;
		}
	}

	private buildClientCapabilities() {
		return {
			...(this.samplingConfig ? { sampling: {} } : {}),
			...(this.elicitationConfig
				? {
						elicitation: {
							form: {},
							...(this.elicitationConfig.allowUrl ? { url: {} } : {}),
						},
					}
				: {}),
		};
	}

	private async createClient(serverName: string): Promise<Client> {
		const { Client } = await loadSdk();
		const capabilities = this.buildClientCapabilities();
		const client = new Client(
			{ name: `pi-mcp-${serverName}`, version: "1.0.0" },
			// mode 'auto' probes server/discover and upgrades to the modern
			// (2026-07-28+) protocol era when the server offers it, falling back
			// to the plain 2025 handshake otherwise. Use it when available.
			{
				...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
				listChanged: {
					tools: {
						onChanged: (error, tools) =>
							this.handleListChanged(serverName, client, "tools", error, tools),
					},
					resources: {
						onChanged: (error, resources) =>
							this.handleListChanged(serverName, client, "resources", error, resources),
					},
				},
				versionNegotiation: { mode: "auto" },
			},
		);
		if (this.samplingConfig) {
			registerSamplingHandler(client, { ...this.samplingConfig, serverName });
		}
		if (this.elicitationConfig) {
			registerElicitationHandler(client, {
				...this.elicitationConfig,
				serverName,
				onUrlAccepted: (elicitationId) => this.rememberUrlElicitation(serverName, elicitationId),
			});
			if (this.elicitationConfig.allowUrl) {
				client.setNotificationHandler("notifications/elicitation/complete", (notification) => {
					const accepted = this.acceptedUrlElicitations.get(serverName);
					if (!accepted?.delete(notification.params.elicitationId)) return;
					this.elicitationConfig?.ui.notify(
						`MCP browser interaction for ${serverName} completed. You can retry the tool now.`,
						"info",
					);
				});
			}
		}
		return client;
	}

	async handleUrlElicitationRequired(
		serverName: string,
		error: UrlElicitationRequiredError,
	): Promise<"accept" | "decline" | "cancel"> {
		if (!this.elicitationConfig?.allowUrl) return "cancel";
		for (const params of error.elicitations) {
			const result = await handleUrlElicitation(
				{
					...this.elicitationConfig,
					serverName,
					onUrlAccepted: (elicitationId) => this.rememberUrlElicitation(serverName, elicitationId),
				},
				params,
			);
			if (result.action !== "accept") return result.action;
		}
		return "accept";
	}

	private rememberUrlElicitation(serverName: string, elicitationId: string): void {
		let accepted = this.acceptedUrlElicitations.get(serverName);
		if (!accepted) {
			accepted = new Set();
			this.acceptedUrlElicitations.set(serverName, accepted);
		}
		accepted.add(elicitationId);
	}

	private async createHttpTransport(
		definition: ServerDefinition,
		serverName: string,
		signal?: AbortSignal,
	): Promise<Transport> {
		throwIfAborted(signal);
		if (!definition.url) throw new Error(`Server ${serverName} has no URL`);
		let url: URL;
		try {
			url = new URL(definition.url);
		} catch (error) {
			throw new Error(`Server ${serverName} has an invalid URL: ${definition.url}`, {
				cause: error,
			});
		}

		// Build headers first (including any bearer token)
		const headers = (await resolveConfigRecord(definition.headers, serverName)) ?? {};

		// For bearer auth, add the token to headers BEFORE creating requestInit
		if (definition.auth === "bearer") {
			const token = resolveBearerToken(definition);
			if (token) {
				headers.Authorization = `Bearer ${token}`;
			}
		}

		// Create request init with headers (Authorization now included for bearer auth)
		const requestInit = Object.keys(headers).length > 0 ? { headers } : undefined;
		const fetch = this.providerFetch(definition, serverName);

		// For OAuth servers, create an auth provider
		let authProvider: McpOAuthProvider | undefined;
		if (supportsOAuth(definition)) {
			const oauthConfig = extractOAuthConfig(await resolveOAuthSecret(definition, serverName));
			authProvider = new McpOAuthProvider(serverName, definition.url!, oauthConfig, {
				onRedirect: async (_authUrl) => {
					// URL is captured by startAuth, no need to log
				},
			});
		}

		const { Client, SSEClientTransport, StreamableHTTPClientTransport } = await loadSdk();
		// Try StreamableHTTP first (modern MCP servers)
		const streamableTransport = new StreamableHTTPClientTransport(url, {
			requestInit,
			authProvider,
			fetch,
		});

		try {
			// Create a test client to verify the transport works
			const testClient = new Client(
				{ name: "pi-mcp-probe", version: "2.1.2" },
				{ versionNegotiation: { mode: "auto" } },
			);
			await testClient.connect(streamableTransport, this.buildRequestOptions(definition, signal));
			await testClient.close().catch(() => {});
			// Close probe transport before creating fresh one
			await streamableTransport.close().catch(() => {});

			// StreamableHTTP works - create fresh transport for actual use
			return new StreamableHTTPClientTransport(url, { requestInit, authProvider, fetch });
		} catch (error) {
			// StreamableHTTP failed, close and try SSE fallback
			await streamableTransport.close().catch(() => {});

			// Host cancellation is not transport capability evidence; do not fall
			// through to SSE when the caller is trying to cancel the connect.
			if (signal?.aborted) {
				throwIfAborted(signal);
			}

			// Terminal auth failure — never fall through to SSE, the server needs auth.
			// SDK v2 surfaces a still-401 (after any provider retry) as SdkHttpError,
			// not UnauthorizedError, so both must be treated as auth-required.
			if (await isUnauthorizedHttpError(error)) {
				throw error;
			}

			// Only fall back to SSE for a typed endpoint-shape mismatch (the server
			// doesn't speak StreamableHTTP). Any other error — 403/500/network/
			// protocol — is real and must propagate, not be masked as "try SSE".
			if (!(await shouldFallbackToSse(error))) {
				throw error;
			}

			// SSE is the legacy transport
			return new SSEClientTransport(url, { requestInit, authProvider, fetch });
		}
	}

	/**
	 * `auth: { provider }`: send the Pi login token on every request. It is read per request,
	 * so a refreshed login applies without a reconnect. Config validation allows it only from
	 * the global Pi mcp.json, for https or loopback http.
	 */
	private providerFetch(
		definition: ServerDefinition,
		serverName: string,
	): ((url: string | URL, init?: RequestInit) => Promise<Response>) | undefined {
		const auth = definition.auth;
		if (typeof auth !== "object" || !auth) return undefined;
		return async (url, init) => {
			const token = await this.providerToken?.(auth.provider);
			if (!token) {
				throw new Error(
					`MCP server "${serverName}" needs a ${auth.provider} login. Run /login ${auth.provider}.`,
				);
			}
			const headers = new Headers(init?.headers);
			headers.set("Authorization", `Bearer ${token}`);
			return fetch(url, { ...init, headers });
		};
	}

	private async fetchAllTools(client: Client, requestOptions?: RequestOptions): Promise<McpTool[]> {
		// Skip when the server does not advertise the capability: the SDK would
		// otherwise console.debug a "does not advertise ... capability" line into
		// the active TUI, and the request is wasted.
		if (!client.getServerCapabilities()?.tools) return [];
		return (await client.listTools(undefined, requestOptions)).tools ?? [];
	}

	private async fetchAllResources(
		client: Client,
		requestOptions?: RequestOptions,
	): Promise<McpResource[]> {
		if (!client.getServerCapabilities()?.resources) return [];
		return (await client.listResources(undefined, requestOptions)).resources ?? [];
	}

	private handleListChanged(
		serverName: string,
		client: Client,
		kind: "tools" | "resources",
		error: Error | null,
		items: McpTool[] | McpResource[] | null,
	): void {
		if (error) {
			logger.error(
				`MCP: Failed to refresh ${kind} for ${serverName}; keeping previous list: ${error.message}`,
			);
			return;
		}
		if (!items) return;

		const connection = this.connections.get(serverName);
		if (connection?.client === client && connection.status === "connected") {
			if (kind === "tools") connection.tools = items as McpTool[];
			else connection.resources = items as McpResource[];
			this.notifyMetadataChanged(serverName);
			return;
		}
		if (this.connectingClients.get(serverName) !== client) return;

		const pending = this.pendingListChanges.get(client) ?? {};
		if (kind === "tools") pending.tools = items as McpTool[];
		else pending.resources = items as McpResource[];
		this.pendingListChanges.set(client, pending);
	}

	private applyPendingListChanges(serverName: string, connection: ServerConnection): void {
		const pending = this.pendingListChanges.get(connection.client);
		this.pendingListChanges.delete(connection.client);
		if (!pending) return;
		if (pending.tools) connection.tools = pending.tools;
		if (pending.resources) connection.resources = pending.resources;
		this.notifyMetadataChanged(serverName);
	}

	private notifyMetadataChanged(serverName: string): void {
		try {
			this.metadataChangedCallback?.(serverName);
		} catch (error) {
			logger.error(`MCP: Failed to update metadata for ${serverName}: ${getErrorMessage(error)}`);
		}
	}

	private attachAdapterNotificationHandlers(serverName: string, client: Client): void {
		// SDK v2: 3-arg setNotificationHandler(method, { params: shape }, handler).
		// The handler now receives params directly (not the full notification).
		client.setNotificationHandler(
			SERVER_STREAM_RESULT_PATCH_METHOD,
			{ params: serverStreamResultPatchNotificationSchema.shape.params },
			(params) => {
				const listener = this.uiStreamListeners.get(params.streamToken);
				if (!listener) return;
				listener(serverName, params);
			},
		);
	}

	registerUiStreamListener(streamToken: string, listener: UiStreamListener): void {
		this.uiStreamListeners.set(streamToken, listener);
	}

	removeUiStreamListener(streamToken: string): void {
		this.uiStreamListeners.delete(streamToken);
	}

	async readResource(name: string, uri: string, signal?: AbortSignal): Promise<ReadResourceResult> {
		const connection = this.connections.get(name);
		if (connection?.status !== "connected") {
			throw new Error(`Server "${name}" is not connected`);
		}

		try {
			this.touch(name);
			this.incrementInFlight(name);
			return await connection.client.readResource({ uri }, this.getRequestOptions(name, signal));
		} finally {
			this.decrementInFlight(name);
			this.touch(name);
		}
	}

	async close(name: string): Promise<void> {
		const connection = this.connections.get(name);
		if (!connection) return;

		// Delete from map BEFORE async cleanup to prevent a race where a
		// concurrent connect() creates a new connection that our deferred
		// delete() would then remove, orphaning the new server process.
		connection.status = "closed";
		this.connections.delete(name);
		this.pendingListChanges.delete(connection.client);
		this.acceptedUrlElicitations.delete(name);
		await connection.client.close().catch(() => {});
		await connection.transport.close().catch(() => {});
	}

	async closeAll(): Promise<void> {
		const names = [...this.connections.keys()];
		await Promise.all(names.map((name) => this.close(name)));
	}

	getConnection(name: string): ServerConnection | undefined {
		return this.connections.get(name);
	}

	getAllConnections(): Map<string, ServerConnection> {
		return new Map(this.connections);
	}

	touch(name: string): void {
		const connection = this.connections.get(name);
		if (connection) {
			connection.lastUsedAt = Date.now();
		}
	}

	incrementInFlight(name: string): void {
		const connection = this.connections.get(name);
		if (connection) {
			connection.inFlight = (connection.inFlight ?? 0) + 1;
		}
	}

	decrementInFlight(name: string): void {
		const connection = this.connections.get(name);
		if (connection?.inFlight) {
			connection.inFlight--;
		}
	}

	isIdle(name: string, timeoutMs: number): boolean {
		const connection = this.connections.get(name);
		if (connection?.status !== "connected") return false;
		if (connection.inFlight > 0) return false;
		return Date.now() - connection.lastUsedAt > timeoutMs;
	}
}

/**
 * Resolve environment variables with interpolation and `!command` values.
 */
async function resolveEnv(
	env: Record<string, string> | undefined,
	serverName: string,
): Promise<Record<string, string>> {
	// Copy process.env, filtering out undefined values
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) {
			resolved[key] = value;
		}
	}

	const overrides = await resolveConfigRecord(env, serverName);
	return overrides ? { ...resolved, ...overrides } : resolved;
}

function normalizeRequestTimeoutMs(timeoutMs: number | undefined): number | undefined {
	return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
		? timeoutMs
		: undefined;
}
