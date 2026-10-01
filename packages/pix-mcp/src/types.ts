// types.ts - Core type definitions

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type {
	SSEClientTransport,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { UiStreamMode } from "./ui-stream-types.ts";

// Transport type (stdio + HTTP)
export type Transport = StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport;

// Import sources for config
export type ImportKind =
	| "cursor"
	| "claude-code"
	| "claude-desktop"
	| "codex"
	| "windsurf"
	| "vscode";

// Tool definition from MCP server
export interface McpTool {
	name: string;
	title?: string;
	description?: string;
	inputSchema?: unknown; // JSON Schema
	_meta?: Record<string, unknown>;
}

// Resource definition from MCP server
export interface McpResource {
	uri: string;
	name: string;
	description?: string;
	mimeType?: string;
	_meta?: Record<string, unknown>;
}

export interface UiResourceMeta {
	csp?: UiResourceCsp;
	permissions?: UiResourcePermissions;
	domain?: string;
	prefersBorder?: boolean;
}

export interface UiResourceContent {
	uri: string;
	html: string;
	mimeType?: string;
	meta: UiResourceMeta;
}

export interface UiProxyRequestBody<TParams> {
	token: string;
	params: TParams;
}

export interface UiProxyResult<T = Record<string, unknown>> {
	ok: boolean;
	result?: T;
	error?: string;
}

export interface UiResourceCsp {
	connectDomains?: string[];
	scriptDomains?: string[];
	styleDomains?: string[];
	fontDomains?: string[];
	imgDomains?: string[];
	mediaDomains?: string[];
	frameDomains?: string[];
	workerDomains?: string[];
	baseUriDomains?: string[];
}

/**
 * MCP-UI permission members are presence-only flags whose value is an empty
 * options object per the spec. `Record<PropertyKey, never>` models "an object
 * with no usable properties" — the exact serialized shape is `{}`.
 */
export type UiResourcePermissionFlag = Record<PropertyKey, never>;

export interface UiResourcePermissions {
	camera?: UiResourcePermissionFlag;
	microphone?: UiResourcePermissionFlag;
	geolocation?: UiResourcePermissionFlag;
	clipboardWrite?: UiResourcePermissionFlag;
}

export interface UiToolInfo {
	id?: string | number;
	tool: {
		name: string;
		description?: string;
		inputSchema?: unknown;
	};
}

export interface UiHostContext {
	toolInfo?: UiToolInfo;
	theme?: "light" | "dark";
	styles?: Record<string, unknown>;
	displayMode?: UiDisplayMode;
	availableDisplayModes?: UiDisplayMode[];
	containerDimensions?: {
		width?: number;
		maxWidth?: number;
		height?: number;
		maxHeight?: number;
	};
	[key: string]: unknown;
}

export type UiDisplayMode = "inline" | "fullscreen" | "pip";

// Re-export stream types from the shared lightweight module.
// This allows the example package to import stream schemas without pulling the full types.ts dependency graph.
export {
	getUiStreamHostContext,
	getVisualizationStreamEnvelope,
	SERVER_STREAM_RESULT_PATCH_METHOD,
	type ServerStreamResultPatchNotification,
	serverStreamResultPatchNotificationSchema,
	UI_STREAM_HOST_CONTEXT_KEY,
	UI_STREAM_REQUEST_META_KEY,
	UI_STREAM_STRUCTURED_CONTENT_KEY,
	type UiStreamHostContext,
	type UiStreamMode,
	type UiStreamSummary,
	uiStreamCallToolResultSchema,
	uiStreamHostContextSchema,
	uiStreamModeSchema,
	type VisualizationStreamEnvelope,
	type VisualizationStreamFrameType,
	type VisualizationStreamPhase,
	type VisualizationStreamStatus,
	visualizationStreamEnvelopeSchema,
	visualizationStreamFrameTypeSchema,
	visualizationStreamPhaseSchema,
	visualizationStreamStatusSchema,
} from "./ui-stream-types.ts";

export interface UiMessageParams {
	role?: string;
	content?: unknown[];
	type?: "prompt" | "notify" | "intent" | "message";
	message?: string;
	prompt?: string;
	intent?: string;
	params?: Record<string, unknown>;
	[key: string]: unknown;
}

/**
 * Extract prompt text from either legacy MCP UI message shapes or native AppBridge user messages.
 */
export function extractUiPromptText(params: UiMessageParams): string | undefined {
	if (params.type === "prompt" || params.prompt) {
		const prompt = params.prompt ?? String(params.message ?? "");
		return prompt || undefined;
	}

	if (params.role === "user" && Array.isArray(params.content)) {
		const text = params.content
			.map((block) =>
				block && typeof block === "object" && "text" in block
					? String((block as { text?: unknown }).text ?? "")
					: "",
			)
			.filter(Boolean)
			.join("\n\n");
		return text || undefined;
	}

	return undefined;
}

/**
 * Structured UI handoff recovered from a canonical prompt envelope.
 */
export interface UiPromptHandoff {
	intent: string;
	params: Record<string, unknown>;
	raw: string;
}

/**
 * Parse a canonical named UI handoff encoded as `intent\n{json}`.
 */
export function parseUiPromptHandoff(prompt: string): UiPromptHandoff | undefined {
	const newlineIndex = prompt.indexOf("\n");
	if (newlineIndex <= 0) {
		return undefined;
	}

	const intent = prompt.slice(0, newlineIndex).trim();
	const payloadText = prompt.slice(newlineIndex + 1).trim();
	if (!intent || !payloadText) {
		return undefined;
	}

	if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(intent)) {
		return undefined;
	}

	try {
		const parsed = JSON.parse(payloadText);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return undefined;
		}
		return {
			intent,
			params: parsed as Record<string, unknown>,
			raw: prompt,
		};
	} catch {
		return undefined;
	}
}

/**
 * Accumulated messages from a UI session.
 * Collected during the session and available when it ends.
 */
export interface UiSessionMessages {
	prompts: string[];
	notifications: string[];
	intents: Array<{ intent: string; params?: Record<string, unknown> }>;
}

export interface UiModelContextParams {
	content?: unknown[];
	structuredContent?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface UiOpenLinkResult {
	isError?: boolean;
	[key: string]: unknown;
}

export interface UiDisplayModeRequest {
	mode?: UiDisplayMode;
}

export interface UiDisplayModeResult {
	mode: UiDisplayMode;
	[key: string]: unknown;
}

// Content types from MCP
export interface McpContent {
	type: "text" | "image" | "audio" | "resource" | "resource_link";
	text?: string;
	data?: string;
	mimeType?: string;
	resource?: {
		uri: string;
		text?: string;
		blob?: string;
	};
	uri?: string;
	name?: string;
	description?: string;
}

// Pi content block type
export type ContentBlock = TextContent | ImageContent;

// OAuth configuration (SDK handles auto-discovery and dynamic registration)
export interface OAuthConfig {
	/** OAuth grant type (defaults to authorization_code) */
	grantType?: "authorization_code" | "client_credentials";
	/** Pre-registered client ID (optional, dynamic registration used if not provided) */
	clientId?: string;
	/** Client secret for confidential clients */
	clientSecret?: string;
	/** Requested OAuth scopes */
	scope?: string;
	/** Exact authorization-code redirect URI for pre-registered clients */
	redirectUri?: string;
	/** Client display name for dynamic registration */
	clientName?: string;
	/** Client homepage URI for dynamic registration */
	clientUri?: string;
}

// Server configuration
export interface ServerEntry {
	/** One-line summary, shown in the proxy server list and the tool namespace. Same field as Pi mcp.json. */
	description?: string;
	/** `false` keeps the entry without connecting to it (Pi mcp.json). */
	enabled?: boolean;
	/** Per-request timeout in seconds (Pi mcp.json). Overrides settings.requestTimeoutMs. */
	timeout?: number;
	/** How tools reach the model (Pi mcp.json). Wins over `directTools`. */
	exposure?: McpExposure;
	/** Per-tool exposure. Keys are server tool names or `*` patterns. */
	toolExposure?: Record<string, McpExposure>;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	// HTTP fields
	url?: string;
	headers?: Record<string, string>;
	/**
	 * Authentication type:
	 * - 'oauth' - Use OAuth 2.1 (auto-discovers endpoints, supports dynamic client registration)
	 * - 'bearer' - Use static Bearer token
	 * - false - Disable authentication
	 * - { provider } - Send the token of a Pi `/login` provider (global Pi mcp.json only)
	 * If not specified and url is present, OAuth will be auto-detected unless custom headers are configured
	 */
	auth?: "oauth" | "bearer" | false | { provider: string };
	bearerToken?: string;
	bearerTokenEnv?: string;
	/**
	 * OAuth configuration (optional).
	 * If not provided, the SDK will attempt dynamic client registration.
	 * Set to false to explicitly disable OAuth for this server.
	 */
	oauth?: OAuthConfig | false;
	lifecycle?: "keep-alive" | "lazy" | "eager";
	idleTimeout?: number; // minutes, overrides global setting
	// Resource handling
	exposeResources?: boolean;
	// Direct tool registration
	directTools?: boolean | string[];
	// Exclude specific MCP tools/resources by original or prefixed name
	excludeTools?: string[];
	// Debug
	debug?: boolean; // Show server stderr (default: false)
}

// Output guard tuning (settings.outputGuard object form)
export interface McpOutputGuardSettings {
	/** Maximum inline MCP text output bytes before truncation/spill-to-disk. Defaults to 51200 (50 KiB). */
	maxBytes?: number;
	/** Maximum inline MCP text output lines before truncation/spill-to-disk. Defaults to 2000. */
	maxLines?: number;
	/** Maximum details.mcpResult JSON bytes kept raw; larger results are summarized and spilled to disk. Defaults to 16384 (16 KiB). */
	detailsMaxBytes?: number;
}

// Settings
export interface McpSettings {
	toolPrefix?: "server" | "none" | "short";
	idleTimeout?: number; // minutes, default 10, 0 to disable
	requestTimeoutMs?: number; // per-request I/O timeout override (ms)
	discoveryLimit?: number; // compact search/list/status result cap, default 12, max 50
	directTools?: boolean;
	disableProxyTool?: boolean;
	autoAuth?: boolean;
	sampling?: boolean;
	samplingAutoApprove?: boolean;
	elicitation?: boolean;
	/**
	 * Guard oversized MCP tool/resource output before it is returned to the model.
	 * Defaults to true (50 KiB / 2,000 lines inline text, 16 KiB details.mcpResult).
	 * Set to false to restore raw MCP output behavior, or pass an object to tune
	 * the limits. Env kill switch: MCP_OUTPUT_GUARD=0.
	 */
	outputGuard?: boolean | McpOutputGuardSettings;
	/**
	 * Message returned in tool results when a server needs (re-)authentication.
	 * "${server}" is substituted with the server name. Defaults to a TUI
	 * instruction when unset.
	 */
	authRequiredMessage?: string;
}

// Root config
export interface McpConfig {
	mcpServers: Record<string, ServerEntry>;
	imports?: ImportKind[];
	settings?: McpSettings;
}

// Alias for clarity
export type ServerDefinition = ServerEntry;

export interface ToolMetadata {
	name: string; // Prefixed tool name (e.g., "xcodebuild_list_sims")
	originalName: string; // Original MCP tool name (e.g., "list_sims")
	description: string;
	resourceUri?: string; // For resource tools: the URI to read
	uiResourceUri?: string; // For app-enabled tools: the UI resource URI
	inputSchema?: unknown; // JSON Schema for parameters (stored for describe/errors)
	uiStreamMode?: UiStreamMode;
}

export interface DirectToolSpec {
	serverName: string;
	originalName: string;
	prefixedName: string;
	description: string;
	inputSchema?: unknown;
	resourceUri?: string;
	uiResourceUri?: string;
	uiStreamMode?: UiStreamMode;
	/** Server summary for the codemode namespace (tool_search ranking, describeNamespace). */
	serverDescription?: string;
	/** Server instructions from initialize, returned by codemode's describeNamespace(). */
	serverInstructions?: string;
}

export interface ServerProvenance {
	path: string;
	kind: "user" | "project" | "import";
	importKind?: string;
}

export interface McpAuthResult {
	ok: boolean;
	message?: string;
}

export interface McpPanelCallbacks {
	reconnect: (serverName: string) => Promise<boolean>;
	disconnect: (serverName: string) => Promise<void>;
	canAuthenticate: (serverName: string) => boolean;
	authenticate: (serverName: string) => Promise<McpAuthResult>;
	getConnectionStatus: (serverName: string) => "connected" | "idle" | "failed" | "needs-auth";
	refreshCacheAfterReconnect: (
		serverName: string,
	) => import("./metadata-cache.ts").ServerCacheEntry | null;
}

export interface AddPanelResultForPanel {
	cancelled: boolean;
	configChanged: boolean;
	serverName?: string;
	targetPath?: string;
	connectStatus?: "connected" | "needs-auth" | "failed";
}
export interface McpPanelResult {
	changes: Map<string, true | string[] | false>;
	/** Visible tool names of each changed server, for `toolExposure` writes. */
	toolNames?: Map<string, string[]>;
	cancelled: boolean;
	addedServer?: AddPanelResultForPanel;
	wantsAdd?: boolean;
	/** Server the user asked to edit; form opens after this panel closes. */
	wantsEdit?: string;
	/** Server the user asked to delete; confirmation + write happen after close. */
	wantsDelete?: string;
}

/**
 * Get server prefix based on tool prefix mode.
 */
export function getServerPrefix(serverName: string, mode: "server" | "none" | "short"): string {
	if (mode === "none") return "";
	if (mode === "short") {
		let short = serverName.replace(/-?mcp$/i, "").replace(/-/g, "_");
		if (!short) short = "mcp";
		return short;
	}
	return serverName.replace(/-/g, "_");
}

/**
 * Format a tool name with server prefix.
 */
export function formatToolName(
	toolName: string,
	serverName: string,
	prefix: "server" | "none" | "short",
): string {
	const p = getServerPrefix(serverName, prefix);
	return p ? `${p}_${toolName}` : toolName;
}

function normalizeToolName(value: string): string {
	return value.replace(/-/g, "_");
}

/** Pi mcp.json exposure. `codemode` and `deferred` both mean the deferred registration here. */
export type McpExposure = "codemode" | "deferred" | "direct" | "hidden";
const EXPOSURES = new Set<string>(["codemode", "deferred", "direct", "hidden"]);

/** A valid exposure, with Pi's old `codemode-deferred` alias resolved. Else undefined. */
export function normalizeExposure(value: unknown): McpExposure | undefined {
	const v = value === "codemode-deferred" ? "codemode" : value;
	return typeof v === "string" && EXPOSURES.has(v) ? (v as McpExposure) : undefined;
}

/**
 * Exposure of one tool, same order as Pi: exact `toolExposure` key, first matching `*` pattern,
 * then the server `exposure`. Undefined means not set, so the legacy `directTools` decides.
 */
export function getToolExposure(
	definition: Pick<ServerEntry, "exposure" | "toolExposure">,
	toolName: string,
): McpExposure | undefined {
	const overrides = definition.toolExposure ?? {};
	const exact = normalizeExposure(overrides[toolName]);
	if (exact) return exact;
	for (const [pattern, value] of Object.entries(overrides)) {
		if (!pattern.includes("*")) continue;
		const source = pattern
			.split("*")
			.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
			.join(".*");
		if (new RegExp(`^${source}$`).test(toolName)) return normalizeExposure(value);
	}
	return normalizeExposure(definition.exposure);
}

/** A legacy `directTools` value, or the global `settings.directTools` fallback. */
export type DirectToolsFilter = boolean | string[] | undefined;

/** Direct when exposure says `direct`. With no exposure set, the legacy `directTools` decides. */
export function isDirectTool(
	definition: Pick<ServerEntry, "exposure" | "toolExposure">,
	toolName: string,
	legacy: DirectToolsFilter,
): boolean {
	const exposure = getToolExposure(definition, toolName);
	if (exposure) return exposure === "direct";
	return legacy === true || (Array.isArray(legacy) && legacy.includes(toolName));
}

/** Excluded by `excludeTools`, or `hidden` by exposure. Hidden tools are unreachable everywhere. */
export function isToolHidden(
	toolName: string,
	serverName: string,
	prefix: "server" | "none" | "short",
	definition: Pick<ServerEntry, "excludeTools" | "exposure" | "toolExposure">,
): boolean {
	return (
		getToolExposure(definition, toolName) === "hidden" ||
		isToolExcluded(toolName, serverName, prefix, definition.excludeTools)
	);
}

export function isToolExcluded(
	toolName: string,
	serverName: string,
	prefix: "server" | "none" | "short",
	excludeTools?: unknown,
): boolean {
	if (!Array.isArray(excludeTools) || excludeTools.length === 0) return false;

	const candidates = new Set<string>([
		normalizeToolName(toolName),
		normalizeToolName(formatToolName(toolName, serverName, prefix)),
		normalizeToolName(formatToolName(toolName, serverName, "server")),
		normalizeToolName(formatToolName(toolName, serverName, "short")),
	]);

	for (const excluded of excludeTools) {
		if (typeof excluded !== "string") continue;
		if (candidates.has(normalizeToolName(excluded))) {
			return true;
		}
	}

	return false;
}
