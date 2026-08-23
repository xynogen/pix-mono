import { matchesKey } from "@earendil-works/pi-tui";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import {
	frameModal,
	MIN_MODAL_HEIGHT,
	ModalPager,
	modalWidth,
	terminalModalHeight,
	wrapTextWithAnsi,
} from "@xynogen/pix-pretty/modal-frame";
import type { ConfigWritePreview, McpDiscoverySummary } from "./config.ts";
import type { McpOnboardingState } from "./onboarding-state.ts";
import { createPanelKeys, type PanelKeybindings, type PanelKeys } from "./panel-keys.ts";
import type { ImportKind } from "./types.ts";

export interface McpSetupPopupTheme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold?(text: string): string;
}

interface SetupTheme {
	border: (text: string) => string;
	title: (text: string) => string;
	selected: (text: string) => string;
	hint: (text: string) => string;
	success: (text: string) => string;
	warning: (text: string) => string;
	muted: (text: string) => string;
}

const ANSI_CODES: Record<string, string> = {
	accent: "36",
	success: "32",
	warning: "33",
	muted: "2",
	dim: "2",
};

const FALLBACK_POPUP_THEME: McpSetupPopupTheme = {
	fg: (color, text) => {
		const code = ANSI_CODES[color];
		return code ? `\x1b[${code}m${text}\x1b[0m` : text;
	},
	bg: (_color, text) => text,
	bold: (text) => `\x1b[1m${text}\x1b[22m`,
};

function createTheme(theme: McpSetupPopupTheme): SetupTheme {
	return {
		border: (text) => theme.fg("accent", text),
		title: (text) => theme.fg("accent", theme.bold?.(text) ?? text),
		selected: (text) => theme.fg("accent", text),
		hint: (text) => theme.fg("dim", text),
		success: (text) => theme.fg("success", text),
		warning: (text) => theme.fg("warning", text),
		muted: (text) => theme.fg("muted", text),
	};
}

function fg(style: (text: string) => string, text: string): string {
	return style(text);
}

// ponytail: use pix-pretty/modal-frame ANSI-safe wrapping (ceiling: wrapTextWithAnsi handles ANSI + unbroken tokens)
function wrapText(text: string, width: number): string[] {
	return width <= 8 ? [text] : wrapTextWithAnsi(text, width);
}

export interface SetupPanelCallbacks {
	previewImports: (imports: ImportKind[]) => ConfigWritePreview;
	previewStarterProject: () => ConfigWritePreview;
	previewRepoPrompt: () => ConfigWritePreview | null;
	adoptImports: (imports: ImportKind[]) => Promise<{ added: ImportKind[]; path: string }>;
	scaffoldProjectConfig: () => Promise<{ path: string }>;
	addRepoPrompt: () => Promise<{ path: string; serverName: string }>;
	openPath: (path: string) => Promise<void>;
	markSetupCompleted: () => void;
}

export interface SetupPanelOptions {
	mode: "empty" | "setup";
	onboardingState: McpOnboardingState;
	keybindings?: PanelKeybindings;
}

type Screen = "empty" | "setup" | "imports" | "paths";

type ActionId =
	| "run-setup"
	| "adopt-imports"
	| "view-example"
	| "show-precedence"
	| "open-paths"
	| "add-repoprompt"
	| "scaffold-project"
	| "close";

interface Action {
	id: ActionId;
	label: string;
	description: string;
}

export class McpSetupPanel {
	private screen: Screen;
	private actionCursor = 0;
	private importCursor = 0;
	private pathCursor = 0;
	private selectedImports = new Set<ImportKind>();
	private busy = false;
	private notice: { text: string; tone: "success" | "warning" | "muted" } | null = null;
	private tui: { requestRender(): void; terminal?: { rows?: number } };
	private popupTheme: McpSetupPopupTheme;
	private t: SetupTheme;
	private keys: PanelKeys;
	private pager = new ModalPager();
	private inactivityTimeout: ReturnType<typeof setTimeout> | null = null;
	private static readonly INACTIVITY_MS = 60_000;

	constructor(
		private discovery: McpDiscoverySummary,
		private callbacks: SetupPanelCallbacks,
		private options: SetupPanelOptions,
		tui: { requestRender(): void; terminal?: { rows?: number } },
		private done: () => void,
		theme: McpSetupPopupTheme = FALLBACK_POPUP_THEME,
	) {
		this.tui = tui;
		this.popupTheme = theme;
		this.t = createTheme(theme);
		this.keys = createPanelKeys(options.keybindings);
		this.screen = options.mode;
		for (const entry of discovery.imports) {
			this.selectedImports.add(entry.kind);
		}
		this.resetInactivityTimeout();
	}

	private resetInactivityTimeout(): void {
		if (this.inactivityTimeout) clearTimeout(this.inactivityTimeout);
		this.inactivityTimeout = setTimeout(() => {
			this.cleanup();
			this.done();
		}, McpSetupPanel.INACTIVITY_MS);
	}

	private cleanup(): void {
		if (this.inactivityTimeout) {
			clearTimeout(this.inactivityTimeout);
			this.inactivityTimeout = null;
		}
	}

	private getActions(): Action[] {
		const actions: Action[] = [];
		if (this.screen === "empty") {
			actions.push({
				id: "run-setup",
				label: "Run setup",
				description: "Inspect detected configs, adopt imports, and scaffold a minimal `.mcp.json`.",
			});
		}
		if (this.discovery.imports.length > 0) {
			actions.push({
				id: "adopt-imports",
				label: "Adopt detected compatibility imports",
				description: `Choose which host-specific MCP configs Pi should import into its own override file. ${this.discovery.imports.length} source${this.discovery.imports.length === 1 ? "" : "s"} found.`,
			});
		}
		actions.push({
			id: "view-example",
			label: "View example `.mcp.json`",
			description: "Preview a working shared MCP config you can paste or adapt.",
		});
		if (!this.discovery.sources.some((source) => source.id === "shared-project" && source.exists)) {
			actions.push({
				id: "scaffold-project",
				label: "Scaffold project `.mcp.json`",
				description:
					"Write a minimal project config using the standard shared MCP file path, then reload Pi.",
			});
		}
		actions.push({
			id: "show-precedence",
			label: "Explain config precedence",
			description: "Show the read order and where Pi writes compatibility settings.",
		});
		if (this.getDetectedPaths().length > 0) {
			actions.push({
				id: "open-paths",
				label: "Open detected config paths",
				description: "Browse the actual config files that Pi discovered on this machine.",
			});
		}
		if (
			!this.discovery.repoPrompt.configured &&
			this.discovery.repoPrompt.executablePath &&
			this.discovery.repoPrompt.targetPath &&
			this.discovery.repoPrompt.entry &&
			this.discovery.repoPrompt.serverName
		) {
			actions.push({
				id: "add-repoprompt",
				label: "Add RepoPrompt to shared MCP config",
				description:
					"Write a standard MCP entry for RepoPrompt to the recommended shared target, then reload MCP in-session.",
			});
		}
		actions.push({ id: "close", label: "Close", description: "Exit the onboarding flow." });
		return actions;
	}

	private getDetectedPaths(): string[] {
		const paths = [
			...this.discovery.sources.filter((source) => source.exists).map((source) => source.path),
			...this.discovery.imports.map((entry) => entry.path),
		];
		return [...new Set(paths)];
	}

	private getSelectedAction(): Action | null {
		const actions = this.getActions();
		return actions[this.actionCursor] ?? null;
	}

	handleInput(data: string): void {
		this.resetInactivityTimeout();
		if (!this.busy) this.notice = null;

		if (matchesKey(data, "ctrl+c")) {
			this.cleanup();
			this.done();
			return;
		}

		if (
			this.pager.handleInput(
				data,
				{
					matches: (input, action) =>
						action === "tui.select.pageUp"
							? this.keys.selectPageUp(input)
							: this.keys.selectPageDown(input),
				},
				true,
			)
		) {
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "escape")) {
			if (this.screen === "imports" || this.screen === "paths") {
				this.screen = this.discovery.hasAnyConfig ? "setup" : "empty";
				this.tui.requestRender();
				return;
			}
			this.cleanup();
			this.done();
			return;
		}

		if (this.busy) return;

		if (this.screen === "imports") {
			this.handleImportsInput(data);
			return;
		}
		if (this.screen === "paths") {
			this.handlePathsInput(data);
			return;
		}

		const actions = this.getActions();
		if (this.keys.selectUp(data)) {
			this.pager.followSelection();
			this.actionCursor = Math.max(0, this.actionCursor - 1);
			this.tui.requestRender();
			return;
		}
		if (this.keys.selectDown(data)) {
			this.pager.followSelection();
			this.actionCursor = Math.min(actions.length - 1, this.actionCursor + 1);
			this.tui.requestRender();
			return;
		}
		if (this.keys.selectConfirm(data)) {
			const selected = this.getSelectedAction();
			if (selected) void this.runAction(selected.id);
		}
	}

	private handleImportsInput(data: string): void {
		const imports = this.discovery.imports;
		if (this.keys.selectUp(data)) {
			this.pager.followSelection();
			this.importCursor = Math.max(0, this.importCursor - 1);
			this.tui.requestRender();
			return;
		}
		if (this.keys.selectDown(data)) {
			this.pager.followSelection();
			this.importCursor = Math.min(imports.length - 1, this.importCursor + 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "space")) {
			const current = imports[this.importCursor];
			if (!current) return;
			if (this.selectedImports.has(current.kind)) {
				this.selectedImports.delete(current.kind);
			} else {
				this.selectedImports.add(current.kind);
			}
			this.tui.requestRender();
			return;
		}
		if (this.keys.selectConfirm(data)) {
			void this.applySelectedImports();
		}
	}

	private handlePathsInput(data: string): void {
		const paths = this.getDetectedPaths();
		if (this.keys.selectUp(data)) {
			this.pager.followSelection();
			this.pathCursor = Math.max(0, this.pathCursor - 1);
			this.tui.requestRender();
			return;
		}
		if (this.keys.selectDown(data)) {
			this.pager.followSelection();
			this.pathCursor = Math.min(paths.length - 1, this.pathCursor + 1);
			this.tui.requestRender();
			return;
		}
		if (this.keys.selectConfirm(data)) {
			const selected = paths[this.pathCursor];
			if (!selected) return;
			void this.runBusy(async () => {
				await this.callbacks.openPath(selected);
				this.notice = { text: `Opened ${selected}`, tone: "success" };
			});
		}
	}

	private async runAction(action: ActionId): Promise<void> {
		if (action === "run-setup") {
			this.screen = "setup";
			this.actionCursor = 0;
			this.tui.requestRender();
			return;
		}
		if (action === "adopt-imports") {
			this.screen = "imports";
			this.importCursor = 0;
			this.tui.requestRender();
			return;
		}
		if (action === "open-paths") {
			this.screen = "paths";
			this.pathCursor = 0;
			this.tui.requestRender();
			return;
		}
		if (action === "scaffold-project") {
			await this.runBusy(async () => {
				const result = await this.callbacks.scaffoldProjectConfig();
				this.callbacks.markSetupCompleted();
				this.notice = {
					text: `Wrote starter config to ${result.path}. Pi will reload after this panel closes.`,
					tone: "success",
				};
			});
			return;
		}
		if (action === "add-repoprompt") {
			await this.runBusy(async () => {
				const result = await this.callbacks.addRepoPrompt();
				this.callbacks.markSetupCompleted();
				this.notice = {
					text: `Added ${result.serverName} to ${result.path}. Pi will reload after this panel closes.`,
					tone: "success",
				};
			});
			return;
		}
		if (action === "close") {
			this.cleanup();
			this.done();
			return;
		}

		this.notice = {
			text: "Review the details below. Press Enter on an action with a side effect to apply it.",
			tone: "muted",
		};
		this.tui.requestRender();
	}

	private async applySelectedImports(): Promise<void> {
		const selected = this.discovery.imports
			.filter((entry) => this.selectedImports.has(entry.kind))
			.map((entry) => entry.kind);
		if (selected.length === 0) {
			this.notice = { text: "Select at least one compatibility import first.", tone: "warning" };
			this.tui.requestRender();
			return;
		}

		await this.runBusy(async () => {
			const result = await this.callbacks.adoptImports(selected);
			this.callbacks.markSetupCompleted();
			this.notice =
				result.added.length > 0
					? {
							text: `Added ${result.added.join(", ")} to ${result.path}. Pi will reload after this panel closes.`,
							tone: "success",
						}
					: { text: `No changes needed in ${result.path}.`, tone: "muted" };
			this.screen = this.discovery.hasAnyConfig ? "setup" : "empty";
			this.actionCursor = 0;
		});
	}

	private async runBusy(fn: () => Promise<void>): Promise<void> {
		this.busy = true;
		this.notice = { text: "Working...", tone: "muted" };
		this.tui.requestRender();
		try {
			await fn();
		} catch (error) {
			this.notice = {
				text: error instanceof Error ? error.message : String(error),
				tone: "warning",
			};
		} finally {
			this.busy = false;
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		const mw = modalWidth(width);
		const innerW = mw - 4;
		const guide = (key: string, action: string) =>
			this.popupTheme.fg("text", key) + fg(this.t.hint, ` ${action}`);
		const guideSep = fg(this.t.hint, " · ");
		const header: string[] = [];
		header.push(this.padLine(fg(this.t.title, `${icon("mcp")}  MCP setup`), innerW));
		header.push(
			this.padLine(fg(this.t.hint, "discover · import · configure external MCP servers"), innerW),
		);
		header.push(this.padLine(this.discoverySummaryLine(), innerW));
		header.push(this.padLine(fg(this.t.muted, this.secondarySummaryLine()), innerW));
		header.push(this.padLine("", innerW));

		if (this.notice) {
			const tone =
				this.notice.tone === "success"
					? this.t.success
					: this.notice.tone === "warning"
						? this.t.warning
						: this.t.hint;
			for (const line of wrapText(this.notice.text, innerW - 6)) {
				header.push(this.padLine(fg(tone, line), innerW));
			}
			header.push(this.padLine("", innerW));
		}

		let body: string[];
		if (this.screen === "imports") body = this.renderImports(innerW);
		else if (this.screen === "paths") body = this.renderPaths(innerW);
		else body = this.renderActions(innerW);

		const selectedBodyLine =
			this.screen === "imports"
				? this.importCursor + 2
				: this.screen === "paths"
					? this.pathCursor + 2
					: this.actionCursor;
		const result = frameModal({
			width: mw,
			maxHeight: terminalModalHeight(this.tui.terminal?.rows),
			minHeight: MIN_MODAL_HEIGHT,
			header,
			body,
			footer: [
				"",
				guide("↑↓", "navigate") +
					guideSep +
					guide("enter", "select") +
					guideSep +
					guide("esc", "back") +
					guideSep +
					guide("ctrl+c", "close"),
				guide("←→/PgUp/PgDn", "inspect overflow"),
			],
			bodyOffset: this.pager.bodyOffset,
			selectedBodyLine: this.pager.selectedLine(selectedBodyLine),
			color: this.t.border,
			bg: (text) => this.popupTheme.bg("customMessageBg", text),
		});
		this.pager.sync(result);
		return result.lines;
	}

	private renderActions(innerW: number): string[] {
		const lines: string[] = [];
		const actions = this.getActions();
		for (let index = 0; index < actions.length; index++) {
			const action = actions[index];
			const selected = index === this.actionCursor;
			const cursor = selected ? fg(this.t.selected, "›") : " ";
			lines.push(`${cursor} ${action.label}`);
		}
		lines.push(this.padLine("", innerW));

		const preview = this.getActionPreview(this.getSelectedAction()?.id ?? "view-example");
		for (const line of preview) {
			lines.push(this.padLine(line, innerW));
		}
		return lines;
	}

	private renderImports(innerW: number): string[] {
		const lines: string[] = [];
		lines.push(
			this.padLine(
				"Select compatibility imports. Space toggles, Enter saves, Esc goes back.",
				innerW,
			),
		);
		lines.push(this.padLine("", innerW));
		for (let index = 0; index < this.discovery.imports.length; index++) {
			const entry = this.discovery.imports[index];
			const selected = this.selectedImports.has(entry.kind) ? "[x]" : "[ ]";
			const cursor = index === this.importCursor ? fg(this.t.selected, "›") : " ";
			lines.push(this.padLine(`${cursor} ${selected} ${entry.kind}  ${entry.path}`, innerW));
		}
		lines.push(this.padLine("", innerW));
		const selected = this.discovery.imports
			.filter((entry) => this.selectedImports.has(entry.kind))
			.map((entry) => entry.kind);
		const preview = this.callbacks.previewImports(selected);
		for (const line of this.formatWritePreview("Compatibility import write preview", preview)) {
			lines.push(this.padLine(line, innerW));
		}
		return lines;
	}

	private renderPaths(innerW: number): string[] {
		const lines: string[] = [];
		lines.push(
			this.padLine("Select a detected config path to open. Enter opens it, Esc goes back.", innerW),
		);
		lines.push(this.padLine("", innerW));
		const paths = this.getDetectedPaths();
		for (let index = 0; index < paths.length; index++) {
			const cursor = index === this.pathCursor ? fg(this.t.selected, "›") : " ";
			lines.push(this.padLine(`${cursor} ${paths[index]}`, innerW));
		}
		return lines;
	}

	private discoverySummaryLine(): string {
		if (!this.discovery.hasAnyConfig) {
			return fg(
				this.t.warning,
				this.options.onboardingState.setupCompleted
					? "No MCP servers are active right now."
					: "No MCP config is active yet.",
			);
		}

		if (
			this.discovery.totalServerCount === 0 &&
			(this.discovery.imports.length > 0 || !!this.discovery.repoPrompt.executablePath)
		) {
			return fg(
				this.t.warning,
				"Pi found MCP-related setup options, but none are active in Pi yet.",
			);
		}

		const shared = this.discovery.sources.filter(
			(source) => source.kind === "shared" && source.serverCount > 0,
		).length;
		const piOwned = this.discovery.sources.filter(
			(source) => source.kind === "pi" && source.serverCount > 0,
		).length;
		return fg(
			this.t.hint,
			`Detected ${this.discovery.totalServerCount} configured servers across ${shared} shared and ${piOwned} Pi-owned source${shared + piOwned === 1 ? "" : "s"}.`,
		);
	}

	private secondarySummaryLine(): string {
		if (!this.discovery.hasAnyConfig) {
			return "Create a shared `.mcp.json`, adopt host imports, or quick-add RepoPrompt from this screen.";
		}
		if (this.discovery.totalServerCount === 0 && this.discovery.imports.length > 0) {
			return `Detected ${this.discovery.imports.length} compatibility import source${this.discovery.imports.length === 1 ? "" : "s"}. Adopt them into Pi or inspect the underlying files.`;
		}
		return "Shared MCP files are preferred. Pi-owned files are only for compatibility imports and adapter-specific overrides.";
	}

	private getActionPreview(action: ActionId): string[] {
		switch (action) {
			case "run-setup":
				return this.formatPreview([
					"Run setup to adopt host-specific imports, inspect detected paths, and scaffold a minimal `.mcp.json` if needed.",
				]);
			case "adopt-imports":
				return this.formatWritePreview(
					"Compatibility import write preview",
					this.callbacks.previewImports(
						this.discovery.imports
							.filter((entry) => this.selectedImports.has(entry.kind))
							.map((entry) => entry.kind),
					),
					[
						`Detected imports: ${this.discovery.imports.map((entry) => `${entry.kind} (${entry.serverCount} servers)`).join(", ")}`,
						"Selected imports are written into the Pi agent dir config as Pi-owned compatibility state.",
					],
				);
			case "view-example":
				return this.formatPreview([
					"Example shared `.mcp.json`:",
					"{",
					'  "mcpServers": {',
					'    "chrome-devtools": {',
					'      "command": "npx",',
					'      "args": ["-y", "chrome-devtools-mcp@latest"]',
					"    }",
					"  }",
					"}",
					"",
					"Use Scaffold project `.mcp.json` when you want a safe empty shell instead of a live example server.",
				]);
			case "show-precedence":
				return this.formatPreview([
					"Read order:",
					"1. ~/.config/mcp/mcp.json",
					"2. <Pi agent dir>/mcp.json",
					"3. .mcp.json",
					"4. .pi/mcp.json",
					"Pi writes compatibility imports and adapter-only overrides to Pi-owned files.",
				]);
			case "open-paths":
				return this.formatPreview(
					this.getDetectedPaths().length > 0
						? ["Detected paths:", ...this.getDetectedPaths()]
						: ["No config paths were detected."],
				);
			case "add-repoprompt": {
				const repoPrompt = this.discovery.repoPrompt;
				const preview = this.callbacks.previewRepoPrompt();
				if (!preview) {
					return this.formatPreview(["RepoPrompt is not available to add from this setup screen."]);
				}
				return this.formatWritePreview("RepoPrompt write preview", preview, [
					`Executable: ${repoPrompt.executablePath ?? "not found"}`,
					`Target: ${repoPrompt.targetPath ?? "n/a"}`,
					`Server name: ${repoPrompt.serverName ?? "repoprompt"}`,
				]);
			}
			case "scaffold-project":
				return this.formatWritePreview(
					"Starter project `.mcp.json` write preview",
					this.callbacks.previewStarterProject(),
					[
						"This writes a minimal `.mcp.json` in the current project using the shared MCP layout.",
						"It intentionally avoids adding a fake placeholder server that would fail on first reload.",
					],
				);
			default:
				return this.formatPreview(["Close the setup flow."]);
		}
	}

	private formatPreview(lines: string[]): string[] {
		const preview: string[] = [];
		for (const line of lines) {
			preview.push(...wrapText(line, 74));
		}
		return preview;
	}

	private formatWritePreview(
		title: string,
		preview: ConfigWritePreview,
		intro: string[] = [],
	): string[] {
		const lines: string[] = [];
		for (const line of intro) {
			lines.push(...wrapText(line, 74));
		}
		if (intro.length > 0) lines.push("");
		lines.push(...wrapText(`${title}: ${preview.path}`, 74));
		lines.push(
			...wrapText(
				preview.existed
					? "Existing file detected. Showing exact before/after diff."
					: "New file will be created. Showing exact content diff.",
				74,
			),
		);
		lines.push("");
		for (const line of preview.diffText.split("\n")) {
			if (line === "--- before" || line === "+++ after") continue; // drop diff headers
			lines.push(...wrapText(line, 74));
		}
		return lines;
	}

	private padLine(text: string, _innerW: number): string {
		// frameModal owns lossless wrapping and row padding. Pre-truncating here
		// would hide command/config tails before the height-aware viewport sees them.
		return text;
	}

	invalidate(): void {}

	dispose(): void {
		this.cleanup();
	}
}

export function createMcpSetupPanel(
	discovery: McpDiscoverySummary,
	callbacks: SetupPanelCallbacks,
	options: SetupPanelOptions,
	tui: { requestRender(): void; terminal?: { rows?: number } },
	done: () => void,
	theme?: McpSetupPopupTheme,
): McpSetupPanel & { dispose(): void } {
	return new McpSetupPanel(discovery, callbacks, options, tui, done, theme);
}
