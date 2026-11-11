/**
 * host.ts — the Pi coding-agent surface (non-UI) for feature packages.
 *
 * Named re-exports only: they keep the host's class identity (Pi maps
 * `@earendil-works/*` to its own copy for extensions) and list the public surface.
 * UI types live in `@xynogen/pix-pretty/tui`, pi-ai in `@xynogen/pix-data/ai`.
 */

import * as agent from "@earendil-works/pi-coding-agent";

export type {
	AgentSession,
	AgentSessionEvent,
	AgentToolResult,
	AgentToolUpdateCallback,
	BashToolInput,
	BuildSystemPromptOptions,
	ContextEditableContent,
	EditToolInput,
	EventBus,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionUIContext,
	FindToolInput,
	GrepToolInput,
	LoadExtensionsResult,
	LsToolInput,
	ProjectTrustContext,
	ProjectTrustEvent,
	ProjectTrustEventResult,
	ReadonlyFooterDataProvider,
	ReadToolInput,
	ReadToolOptions,
	ToolDefinition,
	ToolInfo,
	ToolResultEvent,
	WriteToolInput,
} from "@earendil-works/pi-coding-agent";
export {
	convertToLlm,
	createAgentSession,
	createBashTool,
	createBashToolDefinition,
	createCodingTools,
	createEditTool,
	createEditToolDefinition,
	createFindTool,
	createFindToolDefinition,
	createGrepTool,
	createGrepToolDefinition,
	createLocalPowerShellOperations,
	createLsTool,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	createReadOnlyTools,
	createReadTool,
	createReadToolDefinition,
	createWriteTool,
	createWriteToolDefinition,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	DefaultResourceLoader,
	defineTool,
	detectSupportedImageMimeTypeFromFile,
	getPowerShellConfig,
	isToolCallEventType,
	ModelRegistry,
	ProjectTrustStore,
	parseFrontmatter,
	SessionManager,
	SettingsManager,
	serializeConversation,
	stripFrontmatter,
	truncateHead,
	truncateTail,
} from "@earendil-works/pi-coding-agent";

/** Pi's codemode extension factory, or undefined on hosts that predate it. */
export function codemodeExtension(): typeof agent.createCodemodeExtension | undefined {
	const factory = (agent as Partial<typeof agent>).createCodemodeExtension;
	return typeof factory === "function" ? factory : undefined;
}
