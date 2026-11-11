/**
 * tui.ts — the terminal UI surface for feature packages: pi-tui components and
 * helpers plus Pi's UI types. Named re-exports only, so the host's classes keep
 * their identity. Non-UI Pi API lives in `@xynogen/pix-runtime/host`.
 */

export type {
	ThemeColor,
	ToolRenderers,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
export {
	AssistantMessageComponent,
	CustomEditor,
	getMarkdownTheme,
	Theme,
} from "@earendil-works/pi-coding-agent";
export type {
	Component,
	EditorTheme,
	KeybindingsManager,
	KeyId,
	MarkdownTheme,
	SelectItem,
	TextStyle,
	TUI,
} from "@earendil-works/pi-tui";
export {
	Box,
	Container,
	decodeKittyPrintable,
	Editor,
	fuzzyFilter,
	Input,
	isKeyRelease,
	isKeyRepeat,
	isKittyProtocolActive,
	Key,
	Markdown,
	matchesKey,
	mixColors,
	parseColor,
	parseKey,
	SelectList,
	Spacer,
	sliceByColumn,
	stripTerminalSequences,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
