import { decodeKittyPrintable, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import {
	frameModal,
	MIN_MODAL_HEIGHT,
	ModalPager,
	modalWidth,
	terminalModalHeight,
} from "@xynogen/pix-pretty/modal-frame";
import type { CachedTool, MetadataCache, ServerCacheEntry } from "./metadata-cache.ts";
import { createPanelKeys, type PanelKeybindings, type PanelKeys } from "./panel-keys.ts";
import { resourceNameToToolName } from "./resource-tools.ts";
import type { McpConfig, McpPanelCallbacks, McpPanelResult, ServerProvenance } from "./types.ts";
import { isToolExcluded } from "./types.ts";

/**
 * Recover the printable character a key event represents, or undefined if the
 * event is not a printable key.
 *
 * Under the Kitty keyboard protocol plain characters arrive as CSI-u sequences
 * rather than single bytes, so a bare `data.length === 1` test drops them and
 * typing into the search field does nothing. decodeKittyPrintable handles that
 * encoding; the length check remains as the legacy-terminal path.
 */
function isPrintableCharacter(value: string): boolean {
	const characters = [...value];
	if (characters.length !== 1) return false;
	const codePoint = characters[0]?.codePointAt(0);
	return (
		codePoint !== undefined &&
		codePoint >= 32 &&
		codePoint !== 127 &&
		!(codePoint >= 128 && codePoint <= 159)
	);
}

function printableChar(data: string): string | undefined {
	const decoded = decodeKittyPrintable(data);
	if (decoded !== undefined && isPrintableCharacter(decoded)) return decoded;
	if (isPrintableCharacter(data)) return data;
	return undefined;
}

export interface McpPopupTheme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold?(text: string): string;
}

interface PanelTheme {
	border: (text: string) => string;
	title: (text: string) => string;
	selected: (text: string) => string;
	direct: (text: string) => string;
	needsAuth: (text: string) => string;
	placeholder: (text: string) => string;
	description: (text: string) => string;
	hint: (text: string) => string;
	confirm: (text: string) => string;
	cancel: (text: string) => string;
}

const ANSI_CODES: Record<string, string> = {
	accent: "36",
	success: "32",
	warning: "33",
	error: "31",
	muted: "2",
	dim: "2",
};

const FALLBACK_POPUP_THEME: McpPopupTheme = {
	fg: (color, text) => {
		const code = ANSI_CODES[color];
		return code ? `\x1b[${code}m${text}\x1b[0m` : text;
	},
	bg: (_color, text) => text,
	bold: (text) => `\x1b[1m${text}\x1b[22m`,
};

function createTheme(theme: McpPopupTheme): PanelTheme {
	return {
		border: (text) => theme.fg("accent", text),
		title: (text) => theme.fg("accent", theme.bold?.(text) ?? text),
		selected: (text) => theme.fg("accent", text),
		direct: (text) => theme.fg("success", text),
		needsAuth: (text) => theme.fg("warning", text),
		placeholder: (text) => theme.fg("muted", text),
		description: (text) => theme.fg("muted", text),
		hint: (text) => theme.fg("dim", text),
		confirm: (text) => theme.fg("success", text),
		cancel: (text) => theme.fg("error", text),
	};
}

function fg(style: (text: string) => string, text: string): string {
	return style(text);
}

function fuzzyScore(query: string, text: string): number {
	const lq = query.toLowerCase();
	const lt = text.toLowerCase();
	if (lt.includes(lq)) return 100 + (lq.length / lt.length) * 50;
	let score = 0;
	let qi = 0;
	let consecutive = 0;
	for (let i = 0; i < lt.length && qi < lq.length; i++) {
		if (lt[i] === lq[qi]) {
			score += 10 + consecutive;
			consecutive += 5;
			qi++;
		} else {
			consecutive = 0;
		}
	}
	return qi === lq.length ? score : 0;
}

function sanitizeDisplayText(text: string | null | undefined): string {
	return (text ?? "")
		.replace(/(?:\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x9d[\s\S]*?(?:\x07|\x1b\\|\x9c))/g, "")
		.replace(/(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_])/g, "")
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function sanitizeRowContent(content: string): string {
	let result = "";
	let pendingSpace = false;
	for (let i = 0; i < content.length; i++) {
		const rest = content.slice(i);
		const osc = rest.match(/^(?:\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x9d[\s\S]*?(?:\x07|\x1b\\|\x9c))/);
		if (osc) {
			i += osc[0].length - 1;
			continue;
		}

		const ansi = rest.match(/^(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_])/);
		if (ansi) {
			result += ansi[0];
			i += ansi[0].length - 1;
			continue;
		}

		const code = content.charCodeAt(i);
		if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
			pendingSpace = true;
			continue;
		}

		if (pendingSpace && result && !result.endsWith(" ")) {
			result += " ";
		}
		pendingSpace = false;
		result += content[i];
	}
	return result;
}

function estimateTokens(tool: CachedTool): number {
	const schemaLen = JSON.stringify(tool.inputSchema ?? {}).length;
	const descLen = tool.description?.length ?? 0;
	return Math.ceil((tool.name.length + descLen + schemaLen) / 4) + 10;
}

type ConnectionStatus = "connected" | "idle" | "failed" | "needs-auth" | "connecting";

interface ToolState {
	name: string;
	description: string;
	isDirect: boolean;
	wasDirect: boolean;
	estimatedTokens: number;
}

interface ServerState {
	name: string;
	expanded: boolean;
	source: "user" | "project" | "import";
	importKind?: string;
	excludeTools?: string[];
	exposeResources: boolean;
	connectionStatus: ConnectionStatus;
	tools: ToolState[];
	hasCachedData: boolean;
}

interface VisibleItem {
	type: "server" | "tool";
	serverIndex: number;
	toolIndex?: number;
}

class McpPanel {
	private noticeLines: string[];
	private prefix: "server" | "none" | "short";
	private servers: ServerState[] = [];
	private cursorIndex = 0;
	private nameQuery = "";
	private descSearchActive = false;
	private descQuery = "";
	private dirty = false;
	private confirmingDiscard = false;
	private discardSelected = 1;
	private importNotice: string | null = null;
	private authNotice: string | null = null;
	private authInFlight: string | null = null;
	private inactivityTimeout: ReturnType<typeof setTimeout> | null = null;
	private visibleItems: VisibleItem[] = [];
	private tui: { requestRender(): void; terminal?: { rows?: number } };
	private popupTheme: McpPopupTheme;
	private t: PanelTheme;
	private authOnly: boolean;
	private keys: PanelKeys;
	private pager = new ModalPager();

	private static readonly INACTIVITY_MS = 60_000;

	constructor(
		config: McpConfig,
		cache: MetadataCache | null,
		provenance: Map<string, ServerProvenance>,
		private callbacks: McpPanelCallbacks,
		tui: { requestRender(): void; terminal?: { rows?: number } },
		private done: (result: McpPanelResult) => void,
		options: {
			noticeLines?: string[];
			authOnly?: boolean;
			keybindings?: PanelKeybindings;
			theme?: McpPopupTheme;
		} = {},
	) {
		this.tui = tui;
		this.popupTheme = options.theme ?? FALLBACK_POPUP_THEME;
		this.t = createTheme(this.popupTheme);
		this.noticeLines = options.noticeLines ?? [];
		this.authOnly = options.authOnly === true;
		this.keys = createPanelKeys(options.keybindings);
		this.prefix = config.settings?.toolPrefix ?? "server";

		for (const [serverName, definition] of Object.entries(config.mcpServers)) {
			if (this.authOnly && !callbacks.canAuthenticate(serverName)) continue;
			const prov = provenance.get(serverName);
			const serverCache = cache?.servers?.[serverName];

			const globalDirect = config.settings?.directTools;
			let toolFilter: true | string[] | false = false;
			if (definition.directTools !== undefined) {
				toolFilter = definition.directTools;
			} else if (globalDirect) {
				toolFilter = globalDirect;
			}

			const tools: ToolState[] = [];
			if (serverCache && !this.authOnly) {
				for (const tool of serverCache.tools ?? []) {
					if (isToolExcluded(tool.name, serverName, this.prefix, definition.excludeTools)) {
						continue;
					}

					const isDirect =
						toolFilter === true || (Array.isArray(toolFilter) && toolFilter.includes(tool.name));
					tools.push({
						name: tool.name,
						description: tool.description ?? "",
						isDirect,
						wasDirect: isDirect,
						estimatedTokens: estimateTokens(tool),
					});
				}
				if (definition.exposeResources !== false) {
					for (const resource of serverCache.resources ?? []) {
						const baseName = `get_${resourceNameToToolName(resource.name)}`;
						if (isToolExcluded(baseName, serverName, this.prefix, definition.excludeTools)) {
							continue;
						}

						const isDirect =
							toolFilter === true || (Array.isArray(toolFilter) && toolFilter.includes(baseName));
						const ct: CachedTool = { name: baseName, description: resource.description };
						tools.push({
							name: baseName,
							description: resource.description ?? `Read resource: ${resource.uri}`,
							isDirect,
							wasDirect: isDirect,
							estimatedTokens: estimateTokens(ct),
						});
					}
				}
			}

			const status = callbacks.getConnectionStatus(serverName);

			this.servers.push({
				name: serverName,
				expanded: false,
				source: prov?.kind ?? "user",
				importKind: prov?.importKind,
				excludeTools: definition.excludeTools,
				exposeResources: definition.exposeResources !== false,
				connectionStatus: status,
				tools,
				hasCachedData: !!serverCache,
			});
		}

		this.rebuildVisibleItems();
		this.resetInactivityTimeout();
	}

	private resetInactivityTimeout(): void {
		if (this.inactivityTimeout) clearTimeout(this.inactivityTimeout);
		this.inactivityTimeout = setTimeout(() => {
			this.cleanup();
			this.done({ cancelled: true, changes: new Map() });
		}, McpPanel.INACTIVITY_MS);
	}

	private cleanup(): void {
		if (this.inactivityTimeout) {
			clearTimeout(this.inactivityTimeout);
			this.inactivityTimeout = null;
		}
	}

	private rebuildVisibleItems(): void {
		const query = this.descSearchActive ? this.descQuery : this.nameQuery;
		const mode = this.descSearchActive ? "desc" : "name";

		this.visibleItems = [];
		for (let si = 0; si < this.servers.length; si++) {
			const server = this.servers[si];
			if (query && this.authOnly) {
				const score = mode === "name" ? fuzzyScore(query, server.name) : 0;
				if (score > 0) {
					this.visibleItems.push({ type: "server", serverIndex: si });
				}
				continue;
			}

			this.visibleItems.push({ type: "server", serverIndex: si });
			if (server.expanded || query) {
				for (let ti = 0; ti < server.tools.length; ti++) {
					const tool = server.tools[ti];
					if (query) {
						const score =
							mode === "name"
								? Math.max(fuzzyScore(query, tool.name), fuzzyScore(query, server.name) * 0.6)
								: fuzzyScore(query, tool.description);
						if (score === 0) continue;
					}
					this.visibleItems.push({ type: "tool", serverIndex: si, toolIndex: ti });
				}
			}
		}

		if (query && !this.authOnly) {
			this.visibleItems = this.visibleItems.filter((item) => {
				if (item.type === "server") {
					return this.visibleItems.some(
						(other) => other.type === "tool" && other.serverIndex === item.serverIndex,
					);
				}
				return true;
			});
		}
	}

	private updateDirty(): void {
		this.dirty = this.servers.some((s) => s.tools.some((t) => t.isDirect !== t.wasDirect));
	}

	private buildResult(): McpPanelResult {
		const changes = new Map<string, true | string[] | false>();
		for (const server of this.servers) {
			const changed = server.tools.some((t) => t.isDirect !== t.wasDirect);
			if (!changed) continue;
			const directTools = server.tools.filter((t) => t.isDirect);
			if (directTools.length === server.tools.length && server.tools.length > 0) {
				changes.set(server.name, true);
			} else if (directTools.length === 0) {
				changes.set(server.name, false);
			} else {
				changes.set(
					server.name,
					directTools.map((t) => t.name),
				);
			}
		}
		return { changes, cancelled: false };
	}

	handleInput(data: string): void {
		this.resetInactivityTimeout();
		this.importNotice = null;
		if (!this.authInFlight) this.authNotice = null;

		if (this.confirmingDiscard) {
			this.handleDiscardInput(data);
			return;
		}

		// Global shortcuts — always work, even during desc search
		if (matchesKey(data, "ctrl+c")) {
			this.cleanup();
			this.done({ cancelled: true, changes: new Map() });
			return;
		}

		if (matchesKey(data, "ctrl+s")) {
			this.cleanup();
			this.done(this.buildResult());
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

		// Modal description search mode
		if (this.descSearchActive) {
			if (matchesKey(data, "escape") || this.keys.selectConfirm(data)) {
				this.descSearchActive = false;
				this.descQuery = "";
				this.rebuildVisibleItems();
				this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
				return;
			}
			if (matchesKey(data, "backspace")) {
				if (this.descQuery.length > 0) {
					this.descQuery = this.descQuery.slice(0, -1);
					this.rebuildVisibleItems();
					this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
				}
				return;
			}
			if (this.keys.selectUp(data)) {
				this.moveCursor(-1);
				return;
			}
			if (this.keys.selectDown(data)) {
				this.moveCursor(1);
				return;
			}
			if (matchesKey(data, "space")) {
				// Toggle even while in desc search
				const item = this.visibleItems[this.cursorIndex];
				if (item) this.toggleItem(item);
				return;
			}
			const descChar = printableChar(data);
			if (descChar !== undefined) {
				this.descQuery += descChar;
				this.rebuildVisibleItems();
				this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
				return;
			}
			return;
		}

		if (matchesKey(data, "escape")) {
			if (this.nameQuery) {
				this.nameQuery = "";
				this.rebuildVisibleItems();
				this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
				return;
			}
			if (this.dirty) {
				this.confirmingDiscard = true;
				this.discardSelected = 1;
				return;
			}
			this.cleanup();
			this.done({ cancelled: true, changes: new Map() });
			return;
		}

		if (this.keys.selectUp(data)) {
			this.moveCursor(-1);
			return;
		}
		if (this.keys.selectDown(data)) {
			this.moveCursor(1);
			return;
		}

		if (matchesKey(data, "space")) {
			const item = this.visibleItems[this.cursorIndex];
			if (item && !this.authOnly) this.toggleItem(item);
			return;
		}

		if (this.keys.selectConfirm(data)) {
			const item = this.visibleItems[this.cursorIndex];
			if (!item) return;
			const server = this.servers[item.serverIndex];
			if (item.type === "server") {
				if (this.authOnly || server.connectionStatus === "needs-auth") {
					this.authenticateServer(server);
					return;
				}
				server.expanded = !server.expanded;
				this.rebuildVisibleItems();
				this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
			} else if (item.toolIndex !== undefined) {
				const tool = server.tools[item.toolIndex];
				tool.isDirect = !tool.isDirect;
				if (tool.isDirect && server.source === "import") {
					this.importNotice = `Imported from ${sanitizeDisplayText(server.importKind ?? "external")} — will copy to user config on save`;
				}
				this.updateDirty();
			}
			return;
		}

		if (matchesKey(data, "ctrl+a")) {
			const item = this.visibleItems[this.cursorIndex];
			if (item) this.authenticateSelectedServer(item);
			return;
		}

		if (matchesKey(data, "ctrl+r")) {
			const item = this.visibleItems[this.cursorIndex];
			if (!item) return;
			const server = this.servers[item.serverIndex];
			if (server.connectionStatus === "connecting") return;
			server.connectionStatus = "connecting";
			this.callbacks
				.reconnect(server.name)
				.then(() => {
					server.connectionStatus = this.callbacks.getConnectionStatus(server.name);
					if (server.connectionStatus === "connected") {
						const entry = this.callbacks.refreshCacheAfterReconnect(server.name);
						if (entry) {
							this.rebuildServerTools(server, entry);
						}
						server.hasCachedData = true;
					}
					this.tui.requestRender();
				})
				.catch((error) => {
					server.connectionStatus = "failed";
					const message = sanitizeDisplayText(
						error instanceof Error ? error.message : String(error),
					);
					const serverName = sanitizeDisplayText(server.name);
					this.authNotice = `Reconnect failed for ${serverName}: ${message}`;
					this.tui.requestRender();
				});
			return;
		}

		if (printableChar(data) === "?") {
			if (this.authOnly) return;
			this.descSearchActive = true;
			this.descQuery = "";
			this.rebuildVisibleItems();
			this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
			return;
		}

		// Backspace removes from name query
		if (matchesKey(data, "backspace")) {
			if (this.nameQuery.length > 0) {
				this.nameQuery = this.nameQuery.slice(0, -1);
				this.rebuildVisibleItems();
				this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
			}
			return;
		}

		// All other printable chars → always-on name search
		const nameChar = printableChar(data);
		if (nameChar !== undefined) {
			this.nameQuery += nameChar;
			this.rebuildVisibleItems();
			this.cursorIndex = Math.min(this.cursorIndex, Math.max(0, this.visibleItems.length - 1));
			return;
		}
	}

	private authenticateSelectedServer(item: VisibleItem): void {
		this.authenticateServer(this.servers[item.serverIndex]);
	}

	private authenticateServer(server: ServerState): void {
		if (this.authInFlight) return;
		const serverName = sanitizeDisplayText(server.name);
		if (!this.callbacks.canAuthenticate(server.name)) {
			this.authNotice = `${serverName} does not use OAuth authentication.`;
			return;
		}

		this.authInFlight = server.name;
		this.authNotice = `Authenticating ${serverName}...`;
		this.tui.requestRender();

		this.callbacks
			.authenticate(server.name)
			.then((result) => {
				server.connectionStatus = this.callbacks.getConnectionStatus(server.name);
				const message = sanitizeDisplayText(result.message);
				this.authNotice = result.ok
					? `OAuth finished for ${serverName}. Run reconnect if it is still idle.`
					: `OAuth failed for ${serverName}${message ? `: ${message}` : ". Check the notification for details."}`;
				this.authInFlight = null;
				this.tui.requestRender();
			})
			.catch((error) => {
				const message = sanitizeDisplayText(error instanceof Error ? error.message : String(error));
				server.connectionStatus = this.callbacks.getConnectionStatus(server.name);
				this.authNotice = `OAuth failed for ${serverName}: ${message}`;
				this.authInFlight = null;
				this.tui.requestRender();
			});
	}

	private toggleItem(item: VisibleItem): void {
		if (this.authOnly) return;
		const server = this.servers[item.serverIndex];
		if (item.type === "server") {
			const newState = !server.tools.every((t) => t.isDirect);
			if (server.source === "import" && newState) {
				this.importNotice = `Imported from ${sanitizeDisplayText(server.importKind ?? "external")} — will copy to user config on save`;
			}
			for (const t of server.tools) t.isDirect = newState;
		} else if (item.toolIndex !== undefined) {
			const tool = server.tools[item.toolIndex];
			tool.isDirect = !tool.isDirect;
			if (tool.isDirect && server.source === "import") {
				this.importNotice = `Imported from ${sanitizeDisplayText(server.importKind ?? "external")} — will copy to user config on save`;
			}
		}
		this.updateDirty();
	}

	private handleDiscardInput(data: string): void {
		if (matchesKey(data, "ctrl+c")) {
			this.cleanup();
			this.done({ cancelled: true, changes: new Map() });
			return;
		}
		const discardChar = printableChar(data)?.toLowerCase();
		if (matchesKey(data, "escape") || discardChar === "n") {
			this.confirmingDiscard = false;
			return;
		}
		if (this.keys.selectConfirm(data)) {
			this.cleanup();
			if (this.discardSelected === 0) {
				this.done({ cancelled: true, changes: new Map() });
			} else {
				this.done(this.buildResult());
			}
			return;
		}
		if (discardChar === "y") {
			this.cleanup();
			this.done({ cancelled: true, changes: new Map() });
			return;
		}
		if (matchesKey(data, "left") || matchesKey(data, "right") || matchesKey(data, "tab")) {
			this.discardSelected = this.discardSelected === 0 ? 1 : 0;
		}
	}

	private moveCursor(delta: number): void {
		if (this.visibleItems.length === 0) return;
		this.pager.followSelection();
		this.cursorIndex = Math.max(
			0,
			Math.min(this.visibleItems.length - 1, this.cursorIndex + delta),
		);
	}

	private rebuildServerTools(server: ServerState, entry: ServerCacheEntry): void {
		const existingState = new Map<string, boolean>();
		for (const t of server.tools) existingState.set(t.name, t.isDirect);

		const newTools: ToolState[] = [];
		for (const tool of entry.tools ?? []) {
			if (isToolExcluded(tool.name, server.name, this.prefix, server.excludeTools)) {
				continue;
			}

			const prev = existingState.get(tool.name);
			const isDirect = prev !== undefined ? prev : false;
			newTools.push({
				name: tool.name,
				description: tool.description ?? "",
				isDirect,
				wasDirect:
					prev !== undefined
						? (server.tools.find((t) => t.name === tool.name)?.wasDirect ?? false)
						: false,
				estimatedTokens: estimateTokens(tool),
			});
		}

		if (server.exposeResources) {
			for (const resource of entry.resources ?? []) {
				const baseName = `get_${resourceNameToToolName(resource.name)}`;
				if (isToolExcluded(baseName, server.name, this.prefix, server.excludeTools)) {
					continue;
				}

				const prev = existingState.get(baseName);
				const isDirect = prev !== undefined ? prev : false;
				const ct: CachedTool = { name: baseName, description: resource.description };
				newTools.push({
					name: baseName,
					description: resource.description ?? `Read resource: ${resource.uri}`,
					isDirect,
					wasDirect:
						prev !== undefined
							? (server.tools.find((t) => t.name === baseName)?.wasDirect ?? false)
							: false,
					estimatedTokens: estimateTokens(ct),
				});
			}
		}

		server.tools = newTools;
		this.rebuildVisibleItems();
		this.updateDirty();
	}

	render(width: number): string[] {
		const mw = modalWidth(width);
		const innerW = mw - 4;
		const header: string[] = [];
		const body: string[] = [];
		const footer: string[] = [];
		const t = this.t;
		const bold = (s: string) => this.popupTheme.bold?.(s) ?? `\x1b[1m${s}\x1b[22m`;
		const italic = (s: string) => `\x1b[3m${s}\x1b[23m`;
		const inverse = (s: string) => `\x1b[7m${s}\x1b[27m`;

		// Keep full text; frameModal wraps and pages it. Pre-truncating here would
		// make the omitted tail irrecoverable and invisible to textTruncated.
		const row = (content: string) => sanitizeRowContent(content);
		const emptyRow = () => "";

		const title = this.authOnly ? "MCP OAuth" : "MCP servers";
		const subtitle = this.authOnly
			? "authenticate external MCP services"
			: "servers · direct tools · estimated prompt cost";
		header.push(fg(t.title, `${icon("mcp")}  ${title}`));
		header.push(fg(t.hint, subtitle));
		header.push(fg(t.description, this.descSearchActive ? "Description search:" : "Search:"));

		const cursor = fg(t.selected, "│");
		if (this.descSearchActive) {
			header.push(row(`${this.descQuery}${cursor}`));
		} else if (this.nameQuery) {
			header.push(row(`${this.nameQuery}${cursor}`));
		} else {
			header.push(row(fg(t.placeholder, italic("type to filter..."))));
		}
		if (this.noticeLines.length > 0) {
			for (const notice of this.noticeLines) {
				header.push(row(fg(t.hint, italic(sanitizeDisplayText(notice)))));
			}
			header.push(emptyRow());
		}

		if (this.servers.length === 0) {
			body.push(emptyRow());
			body.push(
				row(
					fg(
						t.hint,
						italic(
							this.authOnly
								? "No OAuth-capable MCP servers configured."
								: "No MCP servers configured.",
						),
					),
				),
			);
			body.push(emptyRow());
		} else {
			const total = this.visibleItems.length;

			body.push(emptyRow());

			for (let i = 0; i < total; i++) {
				const item = this.visibleItems[i];
				const isCursor = i === this.cursorIndex;
				const server = this.servers[item.serverIndex];

				if (item.type === "server") {
					body.push(row(this.renderServerRow(server, isCursor)));
				} else if (item.toolIndex !== undefined) {
					body.push(row(this.renderToolRow(server.tools[item.toolIndex], isCursor)));
				}
			}

			body.push(emptyRow());

			if (this.importNotice) {
				body.push(row(fg(t.needsAuth, italic(sanitizeDisplayText(this.importNotice)))));
				body.push(emptyRow());
			}
			if (this.authNotice) {
				body.push(row(fg(t.needsAuth, italic(sanitizeDisplayText(this.authNotice)))));
				body.push(emptyRow());
			}
		}

		if (this.confirmingDiscard) {
			const discardBtn =
				this.discardSelected === 0
					? inverse(bold(fg(t.cancel, "  Discard  ")))
					: fg(t.hint, "  Discard  ");
			const keepBtn =
				this.discardSelected === 1
					? inverse(bold(fg(t.confirm, "  Keep & Close  ")))
					: fg(t.hint, "  Keep & Close  ");
			footer.push(row(`Discard unsaved changes?  ${discardBtn}   ${keepBtn}`));
		} else {
			if (this.authOnly) {
				footer.push(row(fg(t.description, "select a server to authenticate")));
			} else {
				const directCount = this.servers.reduce(
					(sum, s) => sum + s.tools.filter((t) => t.isDirect).length,
					0,
				);
				const totalTokens = this.servers.reduce(
					(sum, s) =>
						sum + s.tools.filter((t) => t.isDirect).reduce((ts, t) => ts + t.estimatedTokens, 0),
					0,
				);
				const stats =
					directCount > 0
						? `${directCount} direct  ~${totalTokens.toLocaleString()} tokens`
						: "no direct tools";
				footer.push(
					row(fg(t.description, stats + (this.dirty ? fg(t.needsAuth, "  (unsaved)") : ""))),
				);
			}
		}

		footer.push(emptyRow());
		const hints = this.authOnly
			? [
					`${italic("↑↓")} navigate`,
					`${italic("⏎")} auth`,
					`${italic("ctrl+a")} auth`,
					`${italic("esc")} clear/close`,
					`${italic("ctrl+c")} quit`,
				]
			: [
					`${italic("↑↓")} navigate`,
					`${italic("space")} toggle`,
					`${italic("⏎")} expand/auth`,
					`${italic("ctrl+a")} auth`,
					`${italic("ctrl+r")} reconnect`,
					`${italic("?")} desc search`,
					`${italic("ctrl+s")} save`,
					`${italic("esc")} clear/close`,
					`${italic("ctrl+c")} quit`,
				];
		const gap = "  ";
		const gapW = 2;
		const maxW = innerW - 2;
		let curLine = "";
		let curW = 0;
		for (const hint of hints) {
			const hw = visibleWidth(hint);
			const needed = curW === 0 ? hw : gapW + hw;
			if (curW > 0 && curW + needed > maxW) {
				footer.push(row(fg(t.hint, curLine)));
				curLine = hint;
				curW = hw;
			} else {
				curLine += (curW > 0 ? gap : "") + hint;
				curW += needed;
			}
		}
		if (curLine) footer.push(row(fg(t.hint, curLine)));

		const result = frameModal({
			width: mw,
			maxHeight: terminalModalHeight(this.tui.terminal?.rows),
			minHeight: MIN_MODAL_HEIGHT,
			header,
			body,
			footer,
			bodyOffset: this.pager.bodyOffset,
			selectedBodyLine:
				this.visibleItems.length > 0 ? this.pager.selectedLine(this.cursorIndex + 1) : undefined,
			color: t.border,
			bg: (text) => this.popupTheme.bg("customMessageBg", text),
		});
		this.pager.sync(result);
		return result.lines;
	}

	private renderServerRow(server: ServerState, isCursor: boolean): string {
		const t = this.t;
		const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;

		const expandIcon = server.expanded ? "▾" : "▸";
		const prefix = isCursor
			? fg(t.selected, expandIcon)
			: fg(t.border, server.expanded ? expandIcon : "·");

		const serverName = sanitizeDisplayText(server.name);
		const importKind = sanitizeDisplayText(server.importKind ?? "import");
		const nameStr = isCursor ? bold(fg(t.selected, serverName)) : serverName;
		const importLabel = server.source === "import" ? fg(t.description, ` (${importKind})`) : "";
		const statusLabel = this.renderConnectionStatus(server);

		if (!server.hasCachedData && !this.authOnly) {
			return `${prefix}   ${nameStr}${importLabel}  ${fg(t.description, "(not cached)")}${statusLabel}`;
		}

		const directCount = server.tools.filter((t) => t.isDirect).length;
		const totalCount = server.tools.length;
		let toggleIcon = fg(t.description, "○");
		if (directCount === totalCount && totalCount > 0) {
			toggleIcon = fg(t.direct, "●");
		} else if (directCount > 0) {
			toggleIcon = fg(t.needsAuth, "◐");
		}

		let toolInfo = "";
		if (totalCount > 0) {
			toolInfo = `${directCount}/${totalCount}`;
			if (directCount > 0) {
				const tokens = server.tools
					.filter((t) => t.isDirect)
					.reduce((s, t) => s + t.estimatedTokens, 0);
				toolInfo += `  ~${tokens.toLocaleString()}`;
			}
			toolInfo = fg(t.description, toolInfo);
		}

		return `${prefix} ${toggleIcon} ${nameStr}${importLabel}  ${toolInfo}${statusLabel}`;
	}

	private renderConnectionStatus(server: ServerState): string {
		const t = this.t;
		if (this.authInFlight === server.name) return `  ${fg(t.needsAuth, "authenticating")}`;
		if (server.connectionStatus === "needs-auth") return `  ${fg(t.needsAuth, "needs auth")}`;
		if (server.connectionStatus === "connecting") return `  ${fg(t.needsAuth, "connecting")}`;
		if (server.connectionStatus === "failed") return `  ${fg(t.cancel, "failed")}`;
		if (this.authOnly && server.connectionStatus === "connected")
			return `  ${fg(t.direct, "connected")}`;
		if (this.authOnly) return `  ${fg(t.description, "idle")}`;
		return "";
	}

	private renderToolRow(tool: ToolState, isCursor: boolean): string {
		const t = this.t;
		const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;

		const toggleIcon = tool.isDirect ? fg(t.direct, "●") : fg(t.description, "○");
		const cursor = isCursor ? fg(t.selected, "▸") : " ";
		const toolName = sanitizeDisplayText(tool.name);
		const description = sanitizeDisplayText(tool.description);
		const nameStr = isCursor ? bold(fg(t.selected, toolName)) : toolName;

		const descStr = description ? fg(t.description, `— ${description}`) : "";
		return `  ${cursor} ${toggleIcon} ${nameStr} ${descStr}`;
	}

	invalidate(): void {}

	dispose(): void {
		this.cleanup();
	}
}

export function createMcpPanel(
	config: McpConfig,
	cache: MetadataCache | null,
	provenance: Map<string, ServerProvenance>,
	callbacks: McpPanelCallbacks,
	tui: { requestRender(): void; terminal?: { rows?: number } },
	done: (result: McpPanelResult) => void,
	options?: {
		noticeLines?: string[];
		authOnly?: boolean;
		keybindings?: PanelKeybindings;
		theme?: McpPopupTheme;
	},
): McpPanel & { dispose(): void } {
	return new McpPanel(config, cache, provenance, callbacks, tui, done, options ?? {});
}
