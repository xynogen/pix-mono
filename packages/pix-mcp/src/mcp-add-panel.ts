import { decodeKittyPrintable, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import {
	frameModal,
	MIN_MODAL_HEIGHT,
	ModalPager,
	modalWidth,
	terminalModalHeight,
} from "@xynogen/pix-pretty/modal-frame";
import type { AddServerScope, AddServerType, ConfigWritePreview } from "./config.ts";
import { createPanelKeys, type PanelKeybindings, type PanelKeys } from "./panel-keys.ts";
import type { ServerEntry } from "./types.ts";

export interface McpAddPopupTheme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold?(text: string): string;
}

interface AddTheme {
	border: (text: string) => string;
	title: (text: string) => string;
	selected: (text: string) => string;
	hint: (text: string) => string;
	success: (text: string) => string;
	warning: (text: string) => string;
	muted: (text: string) => string;
	error: (text: string) => string;
}

const ANSI_CODES: Record<string, string> = {
	accent: "36",
	success: "32",
	warning: "33",
	error: "31",
	muted: "2",
	dim: "2",
};

const FALLBACK_POPUP_THEME: McpAddPopupTheme = {
	fg: (color, text) => {
		const code = ANSI_CODES[color];
		return code ? `\x1b[${code}m${text}\x1b[0m` : text;
	},
	bg: (_color, text) => text,
	bold: (text) => `\x1b[1m${text}\x1b[22m`,
};

function createTheme(theme: McpAddPopupTheme): AddTheme {
	return {
		border: (text) => theme.fg("accent", text),
		title: (text) => theme.fg("accent", theme.bold?.(text) ?? text),
		selected: (text) => theme.fg("accent", text),
		hint: (text) => theme.fg("dim", text),
		success: (text) => theme.fg("success", text),
		warning: (text) => theme.fg("warning", text),
		muted: (text) => theme.fg("muted", text),
		error: (text) => theme.fg("error", text),
	};
}

function fg(style: (text: string) => string, text: string): string {
	return style(text);
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
		if (pendingSpace && result && !result.endsWith(" ")) result += " ";
		pendingSpace = false;
		result += content[i];
	}
	return result;
}

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

type Step = "pickType" | "form" | "pickScope" | "preview" | "connecting";

interface TypeItem {
	id: AddServerType;
	label: string;
	description: string;
}

const TYPE_ITEMS: TypeItem[] = [
	{
		id: "stdio",
		label: "Local command (stdio)",
		description: "Run a local executable — command + args",
	},
	{ id: "npx", label: "npx package", description: "Quick preset — npx -y <package>" },
	{
		id: "http",
		label: "Remote URL",
		description: "Auto-detects Streamable HTTP or SSE",
	},
];

interface FieldDef {
	key: string;
	label: string;
	placeholder: string;
}

function fieldsForType(type: AddServerType): FieldDef[] {
	const common: FieldDef[] = [{ key: "name", label: "Name", placeholder: "my-server" }];
	if (type === "stdio") {
		return [
			...common,
			{ key: "command", label: "Command", placeholder: "/usr/local/bin/my-mcp" },
			{ key: "args", label: "Args (space-separated)", placeholder: "--stdio --verbose" },
			{ key: "cwd", label: "Cwd (optional)", placeholder: "/path/to/workdir" },
		];
	}
	if (type === "npx") {
		return [
			...common,
			{ key: "pkg", label: "Package", placeholder: "@scope/mcp-server@latest" },
			{ key: "args", label: "Extra args (optional)", placeholder: "--port 3000" },
			{ key: "cwd", label: "Cwd (optional)", placeholder: "" },
		];
	}
	// ponytail: one remote option; connection already probes Streamable HTTP then falls back to SSE.
	return [
		...common,
		{ key: "url", label: "URL", placeholder: "https://example.com/mcp" },
		{ key: "bearerToken", label: "Bearer token (optional)", placeholder: "sk-..." },
	];
}

function parseArgs(value: string): string[] {
	const trimmed = value.trim();
	if (!trimmed) return [];
	return trimmed.split(/\s+/).filter(Boolean);
}

export interface AddPanelCallbacks {
	resolveTargetPath: (scope: AddServerScope) => string;
	previewEntry: (targetPath: string, name: string, entry: ServerEntry) => ConfigWritePreview;
	writeEntry: (targetPath: string, name: string, entry: ServerEntry) => string;
	isNameTaken: (name: string) => boolean;
	testConnect: (serverName: string) => Promise<"connected" | "needs-auth" | "failed">;
}

export interface AddPanelResult {
	cancelled: boolean;
	configChanged: boolean;
	serverName?: string;
	targetPath?: string;
	connectStatus?: "connected" | "needs-auth" | "failed";
}

export class McpAddPanel {
	private step: Step = "pickType";
	private typeCursor = 0;
	private selectedType: AddServerType = "stdio";
	private fieldDefs: FieldDef[] = fieldsForType("stdio");
	private fieldValues: Record<string, string> = {};
	private fieldCursor = 0;
	private scope: AddServerScope = "project";
	private scopeCursor = 0;
	private error: string | null = null;
	private preview: ConfigWritePreview | null = null;
	private connectStatus: string | null = null;
	private busy = false;
	private pasteBuffer = "";
	private isPasting = false;
	private tui: { requestRender(): void; terminal?: { rows?: number } };
	private popupTheme: McpAddPopupTheme;
	private t: AddTheme;
	private keys: PanelKeys;
	private pager = new ModalPager();
	private inactivityTimeout: ReturnType<typeof setTimeout> | null = null;
	private static readonly INACTIVITY_MS = 60_000;

	constructor(
		private options: { cwd: string; callbacks: AddPanelCallbacks },
		tui: { requestRender(): void; terminal?: { rows?: number } },
		private done: (result: AddPanelResult) => void,
		theme: McpAddPopupTheme = FALLBACK_POPUP_THEME,
		keybindings?: PanelKeybindings,
	) {
		this.tui = tui;
		this.popupTheme = theme;
		this.t = createTheme(theme);
		this.keys = createPanelKeys(keybindings);
		for (const f of this.fieldDefs) this.fieldValues[f.key] = "";
		this.resetInactivityTimeout();
	}

	private resetInactivityTimeout(): void {
		if (this.inactivityTimeout) clearTimeout(this.inactivityTimeout);
		this.inactivityTimeout = setTimeout(() => {
			this.cleanup();
			this.done({ cancelled: true, configChanged: false });
		}, McpAddPanel.INACTIVITY_MS);
	}

	private cleanup(): void {
		if (this.inactivityTimeout) {
			clearTimeout(this.inactivityTimeout);
			this.inactivityTimeout = null;
		}
	}

	// Test hooks
	getStep(): Step {
		return this.step;
	}
	getSelectedType(): AddServerType {
		return this.selectedType;
	}
	getError(): string | null {
		return this.error;
	}
	getFieldValue(key: string): string {
		return this.fieldValues[key] ?? "";
	}
	setFieldValue(key: string, value: string): void {
		this.fieldValues[key] = value;
	}

	private buildEntryFromFields(): { name: string; entry: ServerEntry } | { error: string } {
		const name = (this.fieldValues.name ?? "").trim();
		if (!name) return { error: "Server name is required." };
		if (!/^[A-Za-z0-9._-]+$/.test(name))
			return { error: "Name may use letters, digits, dot, dash, underscore only." };
		if (this.options.callbacks.isNameTaken(name))
			return { error: `Server "${name}" already exists.` };

		const type = this.selectedType;
		if (type === "stdio") {
			const command = (this.fieldValues.command ?? "").trim();
			if (!command) return { error: "Command is required for stdio type." };
			const entry: ServerEntry = {
				command,
				args: parseArgs(this.fieldValues.args ?? ""),
				cwd: (this.fieldValues.cwd ?? "").trim() || undefined,
			};
			return { name, entry };
		}
		if (type === "npx") {
			const pkg = (this.fieldValues.pkg ?? "").trim();
			if (!pkg) return { error: "Package name is required for npx type." };
			const extra = parseArgs(this.fieldValues.args ?? "");
			const entry: ServerEntry = {
				command: "npx",
				args: ["-y", pkg, ...extra],
				cwd: (this.fieldValues.cwd ?? "").trim() || undefined,
			};
			return { name, entry };
		}
		const url = (this.fieldValues.url ?? "").trim();
		if (!url) return { error: "URL is required for remote servers." };
		try {
			const parsed = new URL(url);
			if (!/^https?:$/.test(parsed.protocol)) throw new Error("bad protocol");
		} catch {
			return { error: "URL must be http(s)://…" };
		}
		const entry: ServerEntry = { url };
		const token = (this.fieldValues.bearerToken ?? "").trim();
		if (token) entry.bearerToken = token;
		return { name, entry };
	}

	private appendToCurrentField(text: string): void {
		const key = this.fieldDefs[this.fieldCursor]?.key;
		if (!key) return;
		const clean = text.replace(/\r\n|[\r\n]/g, "").replace(/\t/g, "    ");
		this.fieldValues[key] = (this.fieldValues[key] ?? "") + clean;
		this.error = null;
		this.tui.requestRender();
	}

	private handlePasteInput(data: string): boolean {
		if (this.step !== "form") return false;
		if (!this.isPasting && !data.includes("\x1b[200~")) {
			if (data.length <= 1 || data.includes("\x1b")) return false;
			this.appendToCurrentField(data);
			return true;
		}
		if (!this.isPasting) {
			this.isPasting = true;
			this.pasteBuffer = "";
			data = data.replace("\x1b[200~", "");
		}
		this.pasteBuffer += data;
		const end = this.pasteBuffer.indexOf("\x1b[201~");
		if (end === -1) return true;
		this.appendToCurrentField(this.pasteBuffer.slice(0, end));
		const remaining = this.pasteBuffer.slice(end + 6);
		this.pasteBuffer = "";
		this.isPasting = false;
		if (remaining) this.handleInput(remaining);
		return true;
	}

	handleInput(data: string): void {
		this.resetInactivityTimeout();
		if (this.busy && this.step !== "connecting") return;
		if (this.handlePasteInput(data)) return;

		if (matchesKey(data, "ctrl+c")) {
			this.cleanup();
			this.done({ cancelled: true, configChanged: false });
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
			if (this.step === "pickType") {
				this.cleanup();
				this.done({ cancelled: true, configChanged: false });
				return;
			}
			if (this.step === "form") {
				this.step = "pickType";
				this.error = null;
				this.tui.requestRender();
				return;
			}
			if (this.step === "pickScope") {
				this.step = "form";
				this.error = null;
				this.tui.requestRender();
				return;
			}
			if (this.step === "preview") {
				this.step = "pickScope";
				this.error = null;
				this.tui.requestRender();
				return;
			}
			return;
		}

		if (this.step === "pickType") {
			if (this.keys.selectUp(data)) {
				this.typeCursor = Math.max(0, this.typeCursor - 1);
				this.tui.requestRender();
				return;
			}
			if (this.keys.selectDown(data)) {
				this.pager.followSelection();
				this.typeCursor = Math.min(TYPE_ITEMS.length - 1, this.typeCursor + 1);
				this.tui.requestRender();
				return;
			}
			if (this.keys.selectConfirm(data)) {
				this.selectedType = TYPE_ITEMS[this.typeCursor].id;
				this.fieldDefs = fieldsForType(this.selectedType);
				this.fieldValues = {};
				for (const f of this.fieldDefs) this.fieldValues[f.key] = "";
				this.fieldCursor = 0;
				this.step = "form";
				this.error = null;
				this.tui.requestRender();
			}
			return;
		}

		if (this.step === "form") {
			// Field navigation
			if (matchesKey(data, "tab") || this.keys.selectDown(data)) {
				this.fieldCursor = (this.fieldCursor + 1) % this.fieldDefs.length;
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, "shift+tab") || this.keys.selectUp(data)) {
				this.fieldCursor = (this.fieldCursor - 1 + this.fieldDefs.length) % this.fieldDefs.length;
				this.tui.requestRender();
				return;
			}
			if (this.keys.selectConfirm(data)) {
				const built = this.buildEntryFromFields();
				if ("error" in built) {
					this.error = built.error;
					this.tui.requestRender();
					return;
				}
				this.error = null;
				this.step = "pickScope";
				this.scopeCursor = this.scope === "project" ? 0 : 1;
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, "backspace")) {
				const key = this.fieldDefs[this.fieldCursor]?.key;
				if (key) {
					const cur = this.fieldValues[key] ?? "";
					this.fieldValues[key] = cur.slice(0, -1);
					this.error = null;
					this.tui.requestRender();
				}
				return;
			}
			if (matchesKey(data, "ctrl+u")) {
				const key = this.fieldDefs[this.fieldCursor]?.key;
				if (key) {
					this.fieldValues[key] = "";
					this.tui.requestRender();
				}
				return;
			}
			const ch = printableChar(data);
			if (ch !== undefined) {
				const key = this.fieldDefs[this.fieldCursor]?.key;
				if (key) {
					this.fieldValues[key] = (this.fieldValues[key] ?? "") + ch;
					this.error = null;
					this.tui.requestRender();
				}
				return;
			}
			return;
		}

		if (this.step === "pickScope") {
			if (this.keys.selectUp(data)) {
				this.scopeCursor = Math.max(0, this.scopeCursor - 1);
				this.tui.requestRender();
				return;
			}
			if (this.keys.selectDown(data)) {
				this.scopeCursor = Math.min(1, this.scopeCursor + 1);
				this.tui.requestRender();
				return;
			}
			if (this.keys.selectConfirm(data)) {
				this.scope = this.scopeCursor === 0 ? "project" : "global";
				const built = this.buildEntryFromFields();
				if ("error" in built) {
					this.error = built.error;
					this.step = "form";
					this.tui.requestRender();
					return;
				}
				const targetPath = this.options.callbacks.resolveTargetPath(this.scope);
				try {
					this.preview = this.options.callbacks.previewEntry(targetPath, built.name, built.entry);
				} catch (error) {
					this.error = error instanceof Error ? error.message : String(error);
					this.tui.requestRender();
					return;
				}
				this.step = "preview";
				this.error = null;
				this.tui.requestRender();
				return;
			}
			return;
		}

		if (this.step === "preview") {
			if (this.keys.selectConfirm(data)) {
				const built = this.buildEntryFromFields();
				if ("error" in built) {
					this.error = built.error;
					this.step = "form";
					this.tui.requestRender();
					return;
				}
				const targetPath = this.options.callbacks.resolveTargetPath(this.scope);
				this.busy = true;
				this.step = "connecting";
				this.connectStatus = "Writing...";
				this.tui.requestRender();
				try {
					this.options.callbacks.writeEntry(targetPath, built.name, built.entry);
				} catch (error) {
					this.error = error instanceof Error ? error.message : String(error);
					this.step = "preview";
					this.busy = false;
					this.tui.requestRender();
					return;
				}
				this.connectStatus = "Testing connection...";
				this.tui.requestRender();
				this.options.callbacks
					.testConnect(built.name)
					.then((status) => {
						this.cleanup();
						this.done({
							cancelled: false,
							configChanged: true,
							serverName: built.name,
							targetPath,
							connectStatus: status,
						});
					})
					.catch(() => {
						this.cleanup();
						this.done({
							cancelled: false,
							configChanged: true,
							serverName: built.name,
							targetPath,
							connectStatus: "failed",
						});
					});
				return;
			}
			return;
		}
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
		const row = (content: string) => sanitizeRowContent(content);
		const emptyRow = () => "";

		const title = "Add MCP server";
		const stepLabel =
			this.step === "pickType"
				? "1/4 — Choose type"
				: this.step === "form"
					? `2/4 — ${TYPE_ITEMS.find((x) => x.id === this.selectedType)?.label ?? this.selectedType}`
					: this.step === "pickScope"
						? "3/4 — Choose scope"
						: this.step === "preview"
							? "4/4 — Preview"
							: "Writing…";
		header.push(fg(t.title, `${icon("mcp")}  ${title}`));
		header.push(fg(t.hint, stepLabel));
		header.push(emptyRow());

		if (this.step === "pickType") {
			for (let i = 0; i < TYPE_ITEMS.length; i++) {
				const item = TYPE_ITEMS[i];
				const isCursor = i === this.typeCursor;
				const marker = isCursor ? fg(t.selected, "▶") : " ";
				const name = isCursor ? bold(fg(t.selected, item.label)) : item.label;
				const desc = fg(t.muted, `— ${item.description}`);
				body.push(row(`${marker} ${name} ${desc}`));
			}
			if (this.error) body.push(row(fg(t.error, sanitizeDisplayText(this.error))));
		} else if (this.step === "form") {
			for (let i = 0; i < this.fieldDefs.length; i++) {
				const field = this.fieldDefs[i];
				const isFocused = i === this.fieldCursor;
				const value = this.fieldValues[field.key] ?? "";
				const cursor = isFocused ? fg(t.selected, "│") : "";
				const label = isFocused ? bold(fg(t.selected, field.label)) : field.label;
				const displayValue = value
					? sanitizeDisplayText(value)
					: fg(t.muted, italic(field.placeholder));
				const marker = isFocused ? fg(t.selected, "▶") : " ";
				body.push(row(`${marker} ${label}: ${displayValue}${cursor}`));
			}
			body.push(emptyRow());
			body.push(
				row(
					fg(
						t.hint,
						italic("tab: next field · type to edit · backspace · enter: continue · esc: back"),
					),
				),
			);
			if (this.error) {
				body.push(emptyRow());
				body.push(row(fg(t.error, sanitizeDisplayText(this.error))));
			}
		} else if (this.step === "pickScope") {
			const scopes: Array<{ id: AddServerScope; label: string; path: string }> = [
				{
					id: "project",
					label: "Project",
					path: this.options.callbacks.resolveTargetPath("project"),
				},
				{ id: "global", label: "Global", path: this.options.callbacks.resolveTargetPath("global") },
			];
			for (let i = 0; i < scopes.length; i++) {
				const isCursor = i === this.scopeCursor;
				const marker = isCursor ? fg(t.selected, "▶") : " ";
				const name = isCursor ? bold(fg(t.selected, scopes[i].label)) : scopes[i].label;
				const path = fg(t.muted, sanitizeDisplayText(scopes[i].path));
				body.push(row(`${marker} ${name}  ${path}`));
			}
			body.push(emptyRow());
			body.push(
				row(
					fg(
						t.muted,
						"Project writes to .mcp.json in cwd · Global writes to ~/.config/mcp/mcp.json",
					),
				),
			);
			if (this.error) {
				body.push(emptyRow());
				body.push(row(fg(t.error, sanitizeDisplayText(this.error))));
			}
		} else if (this.step === "preview") {
			if (this.preview) {
				const diffLines = this.preview.diffText.split("\n");
				for (const line of diffLines) {
					if (line === "--- before" || line === "+++ after") continue; // drop diff headers
					if (line.startsWith("+ ")) body.push(row(fg(t.success, line)));
					else if (line.startsWith("- ")) body.push(row(fg(t.error, line)));
					else body.push(row(fg(t.muted, line)));
				}
				body.push(emptyRow());
				body.push(row(fg(t.hint, `Target: ${sanitizeDisplayText(this.preview.path)}`)));
			}
			if (this.error) {
				body.push(emptyRow());
				body.push(row(fg(t.error, sanitizeDisplayText(this.error))));
			}
		} else if (this.step === "connecting") {
			body.push(row(fg(t.hint, this.connectStatus ?? "Working…")));
		}

		// Footer hints
		const guide = (key: string, action: string) =>
			fg(t.selected, italic(key)) + fg(t.hint, ` ${action}`);
		const hints =
			this.step === "pickType"
				? [guide("↑↓", "navigate"), guide("⏎", "select"), guide("esc", "cancel")]
				: this.step === "form"
					? [guide("tab", "next"), guide("⏎", "next"), guide("esc", "back")]
					: this.step === "pickScope"
						? [guide("↑↓", "pick"), guide("⏎", "preview"), guide("esc", "back")]
						: this.step === "preview"
							? [guide("⏎", "write & test"), guide("esc", "back")]
							: [];
		if (hints.length > 0) {
			footer.push(emptyRow());
			const gap = "  ";
			const gapW = 2;
			const maxW = innerW - 2;
			let curLine = "";
			let curW = 0;
			for (const hint of hints) {
				const hw = visibleWidth(hint);
				const needed = curW === 0 ? hw : gapW + hw;
				if (curW > 0 && curW + needed > maxW) {
					footer.push(row(curLine));
					curLine = hint;
					curW = hw;
				} else {
					curLine += (curW > 0 ? gap : "") + hint;
					curW += needed;
				}
			}
			if (curLine) footer.push(row(curLine));
		}

		const result = frameModal({
			width: mw,
			maxHeight: terminalModalHeight(this.tui.terminal?.rows),
			minHeight: MIN_MODAL_HEIGHT,
			header,
			body,
			footer,
			bodyOffset: this.pager.bodyOffset,
			selectedBodyLine: undefined,
			color: t.border,
			bg: (text) => this.popupTheme.bg("customMessageBg", text),
		});
		this.pager.sync(result);
		return result.lines;
	}

	invalidate(): void {}

	dispose(): void {
		this.cleanup();
	}
}

export function createMcpAddPanel(
	options: { cwd: string; callbacks: AddPanelCallbacks },
	tui: { requestRender(): void; terminal?: { rows?: number } },
	done: (result: AddPanelResult) => void,
	theme: McpAddPopupTheme = FALLBACK_POPUP_THEME,
	keybindings?: PanelKeybindings,
): McpAddPanel & { dispose(): void } {
	return new McpAddPanel(options, tui, done, theme, keybindings);
}
