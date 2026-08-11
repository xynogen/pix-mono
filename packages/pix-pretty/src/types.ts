import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	BashToolInput,
	EditToolInput,
	ExtensionCommandContext,
	ExtensionContext,
	FindToolInput,
	GrepToolInput,
	LsToolInput,
	ReadToolInput,
	WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import type { FileFinder } from "@ff-labs/fff-node";

// We keep the original shiki-shaped types as plain string aliases so the
// language map and function signatures stay 1:1 with upstream pi-pretty.
export type BundledLanguage = string;

export type BundledTheme = string;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type BgTheme = { getBgAnsi?: (key: string) => string };

export type FgTheme = {
	fg: (key: string, text: string) => string;
	// Optional raw-ANSI accessor exposed by Pi's theme for semantic foregrounds.
	getFgAnsi?: (key: string) => string;
};

export type ImageProtocol = "iterm2" | "kitty" | "none";

export type ToolTextContent = TextContent;

export type ToolImageContent = ImageContent;

export type ToolContent = TextContent | ImageContent;

export type ToolResultLike<TDetails = unknown> = AgentToolResult<TDetails | undefined>;

export type TextComponentLike = {
	setText(value: string): void;
	getText?: () => string;
	render?: (width: number) => string[];
	invalidate?: () => void;
};

export type TextComponentCtor = new (text?: string, x?: number, y?: number) => TextComponentLike;

export type ThemeLike = BgTheme & FgTheme & { bold: (text: string) => string };

export type RenderContextLike<
	TState extends Record<string, string | undefined> = Record<string, string | undefined>,
> = {
	lastComponent?: TextComponentLike;
	state: TState;
	expanded: boolean;
	isError: boolean;
	invalidate: () => void;
	/** Stable id for this tool execution — used to key resize invalidators. */
	toolCallId?: string;
};

type SessionContextLike = ExtensionContext;

export type CommandContextLike = ExtensionCommandContext;

type ToolExecutor<TParams, TDetails = unknown> = (
	toolCallId: string,
	params: TParams,
	signal?: AbortSignal,
	onUpdate?: AgentToolUpdateCallback<TDetails | undefined>,
	ctx?: ExtensionContext,
) => Promise<ToolResultLike<TDetails>>;

export type ToolFactory<TParams, TDetails = unknown> = (cwd: string) => {
	name?: string;
	description?: string;
	label?: string;
	parameters?: unknown;
	execute: ToolExecutor<TParams, TDetails>;
};

export type PiPrettySdk = {
	createReadToolDefinition?: ToolFactory<ReadToolInput>;
	createReadTool?: ToolFactory<ReadToolInput>;
	createBashToolDefinition?: ToolFactory<BashToolInput>;
	createBashTool?: ToolFactory<BashToolInput>;
	createLsToolDefinition?: ToolFactory<LsToolInput>;
	createLsTool?: ToolFactory<LsToolInput>;
	createFindToolDefinition?: ToolFactory<FindToolInput>;
	createFindTool?: ToolFactory<FindToolInput>;
	createGrepToolDefinition?: ToolFactory<GrepToolInput>;
	createGrepTool?: ToolFactory<GrepToolInput>;
	createEditToolDefinition?: ToolFactory<EditToolInput>;
	createEditTool?: ToolFactory<EditToolInput>;
	createWriteToolDefinition?: ToolFactory<WriteToolInput>;
	createWriteTool?: ToolFactory<WriteToolInput>;
	getAgentDir?: () => string;
};

export type PiPrettyApi = {
	registerTool: (tool: unknown) => void;
	registerCommand: (
		name: string,
		command: {
			description?: string;
			handler: (args: string, ctx: CommandContextLike) => Promise<void> | void;
		},
	) => void;
	on: (
		event: string,
		handler: (event: unknown, ctx: SessionContextLike) => Promise<void> | void,
	) => void;
};

export type OptionalFffModule = { FileFinder: typeof FileFinder };

export type FffBackedFinder = FileFinder;

export type ReadParams = ReadToolInput;

export type BashParams = BashToolInput;

// The defensive renderers below accept several legacy / alternate field names
// (snake_case + singular shapes) that upstream's strict tool-input types no
// longer declare. We model the full accepted superset here so the runtime
// fallbacks stay type-safe. These are intentionally standalone (not an
// intersection with EditToolInput/WriteToolInput) because the upstream `edits`
// element type is narrower and would conflict with the legacy item shape.
export type EditOperationInput = {
	oldText?: string;
	newText?: string;
	old_text?: string;
	new_text?: string;
};

export type EditParams = {
	path?: string;
	file_path?: string;
	edits?: EditOperationInput[];
} & EditOperationInput;

export type WriteParams = {
	path?: string;
	file_path?: string;
	content?: string;
};

// Keep a reference to the upstream input types so the import stays meaningful
// and future drift is visible at this seam.
export type UpstreamEditToolInput = EditToolInput;
export type UpstreamWriteToolInput = WriteToolInput;

// A single old→new replacement extracted from an edit tool call (supports both
// the single oldText/newText shape and the batched `edits[]` shape).
export type EditOperation = { oldText: string; newText: string };

export type LsParams = LsToolInput;

export type FindParams = FindToolInput;

export type GrepParams = GrepToolInput;

export type EditRenderState = {
	_pk?: string;
	_pt?: string;
	_edk?: string;
	_edt?: string;
};

export type WriteRenderState = {
	_previewKey?: string;
	_previewText?: string;
	_wdk?: string;
	_wdt?: string;
	_nfk?: string;
	_nft?: string;
};

export type FindResultDetails = {
	_type: "findResult";
	text: string;
	pattern: string;
	path?: string;
	matchCount: number;
};

export type GrepResultDetails = {
	_type: "grepResult";
	text: string;
	pattern: string;
	path?: string;
	matchCount: number;
};

export type RenderDetails =
	| { _type: "readImage"; filePath: string; data: string; mimeType: string }
	| {
			_type: "readFile";
			filePath: string;
			content: string;
			offset: number;
			lineCount: number;
	  }
	| {
			_type: "bashResult";
			text: string;
			exitCode: number | null;
			command: string;
	  }
	| { _type: "lsResult"; text: string; path: string; entryCount: number }
	| FindResultDetails
	| GrepResultDetails
	| EditInfoDetails
	| MultiEditInfoDetails
	| EditDiffDetails
	| WriteDiffDetails
	| WriteNewDetails
	| WriteNoChangeDetails;

// --- edit/write render detail payloads (stored on result.details) ---
export type EditInfoDetails = {
	_type: "editInfo";
	summary: string;
	editLine: number;
	/** Full diff payload for split-view rendering */
	oldContent: string;
	newContent: string;
	language: string | undefined;
	filePath: string;
};

export type MultiEditInfoDetails = {
	_type: "multiEditInfo";
	summary: string;
	editCount: number;
	diffLineCount: number;
	/** Per-operation diffs for split-view rendering */
	ops: Array<{
		oldContent: string;
		newContent: string;
		language: string | undefined;
		filePath: string;
	}>;
};

export type WriteDiffDetails = {
	_type: "diff";
	summary: string;
	oldContent: string;
	newContent: string;
	language: string | undefined;
};

export type WriteNewDetails = {
	_type: "new";
	lines: number;
	content: string;
	filePath: string;
};

export type WriteNoChangeDetails = { _type: "noChange" };

export type EditDiffDetails = {
	_type: "editDiff";
	summary: string;
	oldContent: string;
	newContent: string;
	language: string | undefined;
	filePath: string;
};

export interface PiPrettyDeps {
	sdk: PiPrettySdk;
	TextComponent: TextComponentCtor;
	fffModule?: OptionalFffModule;
}
