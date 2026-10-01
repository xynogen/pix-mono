import { decodeKittyPrintable, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import {
	frameModal,
	MIN_MODAL_HEIGHT,
	ModalPager,
	modalWidth,
	terminalModalHeight,
} from "@xynogen/pix-pretty/modal-frame";
import { getErrorMessage } from "@xynogen/pix-pretty/utils";
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

// Only direct callers (tests) land here: ctx.ui.custom always passes the host theme.
// Plain text, so no palette of our own drifts from the theme.
const FALLBACK_POPUP_THEME: McpAddPopupTheme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
};

function createTheme(theme: McpAddPopupTheme): AddTheme {
	return {
		border: (text) => theme.fg("accent", text),
		title: (text) => theme.fg("accent", theme.bold?.(text) ?? text),
		selected: (text) => theme.fg("accent", text),
		hint: (text) => theme.fg("muted", text),
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
		label: "stdio / CLI",
		description: "Run local command and communicate over stdin/stdout",
	},
	{
		id: "http",
		label: "URL / HTTP",
		description: "Connect by URL; Streamable HTTP with legacy SSE fallback",
	},
];

interface FieldDef {
	key: string;
	label: string;
	placeholder: string;
	hint?: string;
	secret?: boolean;
	toggle?: boolean;
}

function fieldsForType(type: AddServerType): FieldDef[] {
	const common: FieldDef[] = [
		{ key: "name", label: "Name", placeholder: "my-server", hint: "letters, digits, . _ -" },
	];
	const directTools: FieldDef = {
		key: "directTools",
		label: "Direct tools",
		placeholder: "off",
		hint: "register this server's tools as native tools (space toggles)",
		toggle: true,
	};
	const exposeResources: FieldDef = {
		key: "exposeResources",
		label: "Resource tools",
		placeholder: "off",
		hint: "turn each MCP resource into a get_<name> tool (space toggles)",
		toggle: true,
	};
	// Pi mcp.json fields, shared by both transports.
	const piFields: FieldDef[] = [
		{
			key: "description",
			label: "Description",
			placeholder: "what the server offers",
			hint: "one line, shown in the mcp tool server list",
		},
		{
			key: "timeout",
			label: "Timeout (s)",
			placeholder: "default",
			hint: "per-request timeout in seconds",
		},
		{
			key: "disabled",
			label: "Disabled",
			placeholder: "off",
			hint: "keep the entry without connecting (space toggles)",
			toggle: true,
		},
	];
	if (type === "stdio") {
		return [
			...common,
			{
				key: "command",
				label: "Command",
				placeholder: "npx",
				hint: "executable name or absolute path",
			},
			{
				key: "args",
				label: "Args",
				placeholder: '["-y","@scope/server"]',
				hint: 'JSON array, e.g. ["-y","@scope/server"]',
			},
			{
				key: "env",
				label: "Env",
				placeholder: '{"API_KEY":"$API_KEY"}',
				hint: 'JSON object, e.g. {"API_KEY":"$API_KEY"}',
			},
			{
				key: "cwd",
				label: "Cwd",
				placeholder: "/path/to/workdir",
				hint: "optional working directory",
			},
			directTools,
			exposeResources,
			...piFields,
		];
	}
	// ponytail: one URL option; connection probes Streamable HTTP then legacy SSE.
	return [
		...common,
		{
			key: "url",
			label: "URL",
			placeholder: "https://example.com/mcp",
			hint: "http(s) MCP endpoint",
		},
		{
			key: "headers",
			label: "Headers",
			placeholder: '{"X-API-Key":"$API_KEY"}',
			hint: 'JSON object, e.g. {"X-API-Key":"$API_KEY"}',
		},
		{
			key: "bearerTokenEnv",
			label: "Token env",
			placeholder: "GITHUB_TOKEN",
			hint: "env var name, e.g. GITHUB_TOKEN",
		},
		{
			key: "bearerToken",
			label: "Bearer token",
			placeholder: "optional literal token",
			hint: "prefer Token env; saved as plaintext",
			secret: true,
		},
		directTools,
		exposeResources,
		...piFields,
	];
}

function parseOptionalJson<T>(
	value: string,
	label: string,
	expected: "array" | "object",
): T | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		throw new Error(`${label} must be valid JSON.`);
	}
	if (
		expected === "array"
			? !Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")
			: !parsed || Array.isArray(parsed) || typeof parsed !== "object"
	) {
		throw new Error(`${label} must be a JSON ${expected} of strings.`);
	}
	if (
		expected === "object" &&
		Object.values(parsed as Record<string, unknown>).some((item) => typeof item !== "string")
	) {
		throw new Error(`${label} values must be strings.`);
	}
	return parsed as T;
}

// ponytail: the /mcp panel toggle is binary (all tools on, or off/unset).
// A per-tool allow-list (directTools: string[]) stays a config-file-only advanced
// case; editing such a server via the panel collapses it to the on state.
function parseDirectTools(value: string): boolean | undefined {
	return value === "true" ? true : undefined;
}

function serializeDirectTools(directTools: boolean | string[] | undefined): string {
	return directTools === true || (Array.isArray(directTools) && directTools.length > 0)
		? "true"
		: "";
}

// Unset means off (the runtime default). Only an explicit on is written to config.
function parseExposeResources(value: string): true | undefined {
	return value === "true" ? true : undefined;
}

/** Description, timeout, and disabled fields → entry fields. Unset values are removed. */
function parsePiFields(
	values: Record<string, string>,
): Pick<ServerEntry, "description" | "timeout" | "enabled"> | { error: string } {
	const timeoutText = (values.timeout ?? "").trim();
	const timeout = timeoutText ? Number(timeoutText) : undefined;
	if (timeout !== undefined && !(Number.isFinite(timeout) && timeout > 0))
		return { error: "Timeout must be a positive number of seconds." };
	return {
		description: (values.description ?? "").trim() || undefined,
		timeout,
		enabled: values.disabled === "true" ? false : undefined,
	};
}

function inferType(entry: ServerEntry): AddServerType {
	return entry.url ? "http" : "stdio";
}

function stepLabel(step: Step, type: AddServerType, editing: boolean): string {
	if (editing) {
		if (step === "form")
			return `1/2 — ${TYPE_ITEMS.find((item) => item.id === type)?.label ?? type}`;
		if (step === "preview") return "2/2 — Preview";
		return "Writing…";
	}
	if (step === "pickType") return "1/4 — Choose transport";
	if (step === "form") return `2/4 — ${TYPE_ITEMS.find((item) => item.id === type)?.label ?? type}`;
	if (step === "pickScope") return "3/4 — Choose scope";
	if (step === "preview") return "4/4 — Preview";
	return "Writing…";
}

function displayFieldValue(field: FieldDef, value: string, mutedPlaceholder: string): string {
	if (field.toggle) return value === "true" ? "[x] on" : "[ ] off";
	if (!value) return mutedPlaceholder;
	return field.secret ? "•".repeat(Math.min(value.length, 24)) : sanitizeDisplayText(value);
}

function fieldsFromEntry(name: string, entry: ServerEntry): Record<string, string> {
	return {
		name,
		command: entry.command ?? "",
		args: entry.args?.length ? JSON.stringify(entry.args) : "",
		env: entry.env && Object.keys(entry.env).length ? JSON.stringify(entry.env) : "",
		cwd: entry.cwd ?? "",
		directTools: serializeDirectTools(entry.directTools),
		exposeResources: entry.exposeResources === true ? "true" : "",
		url: entry.url ?? "",
		headers:
			entry.headers && Object.keys(entry.headers).length ? JSON.stringify(entry.headers) : "",
		bearerTokenEnv: entry.bearerTokenEnv ?? "",
		bearerToken: entry.bearerToken ?? "",
		description: entry.description ?? "",
		timeout: entry.timeout !== undefined ? String(entry.timeout) : "",
		disabled: entry.enabled === false ? "true" : "",
	};
}

export interface AddPanelCallbacks {
	resolveTargetPath: (scope: AddServerScope) => string;
	previewEntry: (targetPath: string, name: string, entry: ServerEntry) => ConfigWritePreview;
	writeEntry: (targetPath: string, name: string, entry: ServerEntry) => string;
	isNameTaken: (name: string) => boolean;
	testConnect: (
		serverName: string,
		entry: ServerEntry,
	) => Promise<"connected" | "needs-auth" | "failed">;
}

export interface AddPanelResult {
	cancelled: boolean;
	configChanged: boolean;
	serverName?: string;
	targetPath?: string;
	connectStatus?: "connected" | "needs-auth" | "failed" | "disabled";
}

export interface EditPanelOptions {
	name: string;
	targetPath: string;
	entry: ServerEntry;
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
		private options: { cwd: string; callbacks: AddPanelCallbacks; edit?: EditPanelOptions },
		tui: { requestRender(): void; terminal?: { rows?: number } },
		private done: (result: AddPanelResult) => void,
		theme: McpAddPopupTheme = FALLBACK_POPUP_THEME,
		keybindings?: PanelKeybindings,
	) {
		this.tui = tui;
		this.popupTheme = theme;
		this.t = createTheme(theme);
		this.keys = createPanelKeys(keybindings);
		if (options.edit) {
			this.step = "form";
			this.selectedType = inferType(options.edit.entry);
			this.fieldDefs = fieldsForType(this.selectedType);
			this.fieldValues = fieldsFromEntry(options.edit.name, options.edit.entry);
		} else {
			for (const f of this.fieldDefs) this.fieldValues[f.key] = "";
		}
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

	private currentFieldIsReadOnly(): boolean {
		// ponytail: renaming needs atomic delete+add; keep edit scope to entry fields for now.
		return Boolean(this.options.edit && this.fieldDefs[this.fieldCursor]?.key === "name");
	}

	private buildEntryFromFields(): { name: string; entry: ServerEntry } | { error: string } {
		const name = (this.fieldValues.name ?? "").trim();
		if (!name) return { error: "Server name is required." };
		if (!/^[A-Za-z0-9._-]+$/.test(name))
			return { error: "Name may use letters, digits, dot, dash, underscore only." };
		if (this.options.callbacks.isNameTaken(name) && name !== this.options.edit?.name)
			return { error: `Server "${name}" already exists.` };

		const pi = parsePiFields(this.fieldValues);
		if ("error" in pi) return pi;

		const type = this.selectedType;
		if (type === "stdio") {
			const command = (this.fieldValues.command ?? "").trim();
			if (!command) return { error: "Command is required for stdio type." };
			try {
				const args = parseOptionalJson<string[]>(this.fieldValues.args ?? "", "Args", "array");
				const env = parseOptionalJson<Record<string, string>>(
					this.fieldValues.env ?? "",
					"Env",
					"object",
				);
				const directTools = parseDirectTools(this.fieldValues.directTools ?? "");
				const entry: ServerEntry = {
					...this.options.edit?.entry,
					command,
					args: args ?? [],
					env,
					cwd: (this.fieldValues.cwd ?? "").trim() || undefined,
					directTools,
					exposeResources: parseExposeResources(this.fieldValues.exposeResources ?? ""),
					...pi,
				};
				return { name, entry };
			} catch (error) {
				return { error: getErrorMessage(error) };
			}
		}
		const url = (this.fieldValues.url ?? "").trim();
		if (!url) return { error: "URL is required for remote servers." };
		try {
			const parsed = new URL(url);
			if (!/^https?:$/.test(parsed.protocol)) throw new Error("bad protocol");
		} catch {
			return { error: "URL must be http(s)://…" };
		}
		const entry: ServerEntry = { ...this.options.edit?.entry, url };
		try {
			entry.headers = parseOptionalJson<Record<string, string>>(
				this.fieldValues.headers ?? "",
				"Headers",
				"object",
			);
		} catch (error) {
			return { error: getErrorMessage(error) };
		}
		entry.bearerTokenEnv = (this.fieldValues.bearerTokenEnv ?? "").trim() || undefined;
		entry.bearerToken = (this.fieldValues.bearerToken ?? "").trim() || undefined;
		entry.directTools = parseDirectTools(this.fieldValues.directTools ?? "");
		entry.exposeResources = parseExposeResources(this.fieldValues.exposeResources ?? "");
		Object.assign(entry, pi);
		return { name, entry };
	}

	private appendToCurrentField(text: string): void {
		if (this.currentFieldIsReadOnly()) return;
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

	private handleEscape(data: string): boolean {
		if (!matchesKey(data, "escape")) return false;
		if (this.step === "pickType" || (this.step === "form" && this.options.edit)) {
			this.cleanup();
			this.done({ cancelled: true, configChanged: false });
			return true;
		}
		if (this.step === "form") {
			this.step = "pickType";
		} else if (this.step === "pickScope" || this.step === "preview") {
			this.step = this.options.edit ? "form" : this.step === "preview" ? "pickScope" : "form";
		}
		this.error = null;
		this.tui.requestRender();
		return true;
	}

	private handleFormInput(data: string): void {
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
		const focused = this.fieldDefs[this.fieldCursor];
		if (
			focused?.toggle &&
			(data === " " || matchesKey(data, "left") || matchesKey(data, "right"))
		) {
			this.fieldValues[focused.key] =
				(this.fieldValues[focused.key] ?? "") === "true" ? "" : "true";
			this.error = null;
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
			if (this.options.edit) {
				try {
					this.preview = this.options.callbacks.previewEntry(
						this.options.edit.targetPath,
						built.name,
						built.entry,
					);
				} catch (error) {
					this.error = getErrorMessage(error);
					this.tui.requestRender();
					return;
				}
				this.step = "preview";
			} else {
				this.step = "pickScope";
				this.scopeCursor = this.scope === "project" ? 0 : 1;
			}
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "backspace")) {
			if (this.currentFieldIsReadOnly() || focused?.toggle) return;
			const key = focused?.key;
			if (key) {
				const cur = this.fieldValues[key] ?? "";
				this.fieldValues[key] = cur.slice(0, -1);
				this.error = null;
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, "ctrl+u")) {
			if (this.currentFieldIsReadOnly() || focused?.toggle) return;
			const key = focused?.key;
			if (key) {
				this.fieldValues[key] = "";
				this.tui.requestRender();
			}
			return;
		}
		const ch = printableChar(data);
		if (ch !== undefined) {
			if (this.currentFieldIsReadOnly() || focused?.toggle) return;
			const key = focused?.key;
			if (key) {
				this.fieldValues[key] = (this.fieldValues[key] ?? "") + ch;
				this.error = null;
				this.tui.requestRender();
			}
			return;
		}
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

		if (this.handleEscape(data)) return;

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
			this.handleFormInput(data);
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
					this.error = getErrorMessage(error);
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
				const targetPath =
					this.options.edit?.targetPath ?? this.options.callbacks.resolveTargetPath(this.scope);
				this.busy = true;
				this.step = "connecting";
				this.connectStatus = "Writing...";
				this.tui.requestRender();
				try {
					this.options.callbacks.writeEntry(targetPath, built.name, built.entry);
				} catch (error) {
					this.error = getErrorMessage(error);
					this.step = "preview";
					this.busy = false;
					this.tui.requestRender();
					return;
				}
				if (built.entry.enabled === false) {
					// A disabled server must not connect, so skip the connection test.
					this.cleanup();
					this.done({
						cancelled: false,
						configChanged: true,
						serverName: built.name,
						targetPath,
						connectStatus: "disabled",
					});
					return;
				}
				this.connectStatus = "Testing connection...";
				this.tui.requestRender();
				this.options.callbacks
					.testConnect(built.name, built.entry)
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

		const title = this.options.edit ? "Edit MCP server" : "Add MCP server";
		header.push(fg(t.title, `${icon("mcp")}  ${title}`));
		header.push(fg(t.hint, stepLabel(this.step, this.selectedType, !!this.options.edit)));
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
				const displayValue = displayFieldValue(
					field,
					value,
					fg(t.muted, italic(field.placeholder)),
				);
				const marker = isFocused ? fg(t.selected, "▶") : " ";
				const hint = field.hint ? fg(t.muted, ` — ${field.hint}`) : "";
				body.push(row(`${marker} ${label}: ${displayValue}${cursor}${hint}`));
			}
			body.push(emptyRow());
			body.push(
				row(
					fg(
						t.hint,
						italic(
							"tab: next field · type to edit · space: toggle · backspace · enter: continue · esc: back",
						),
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
	options: { cwd: string; callbacks: AddPanelCallbacks; edit?: EditPanelOptions },
	tui: { requestRender(): void; terminal?: { rows?: number } },
	done: (result: AddPanelResult) => void,
	theme: McpAddPopupTheme = FALLBACK_POPUP_THEME,
	keybindings?: PanelKeybindings,
): McpAddPanel & { dispose(): void } {
	return new McpAddPanel(options, tui, done, theme, keybindings);
}
