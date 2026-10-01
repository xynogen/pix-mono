// config.ts - Config loading with import support

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { writeFileAtomicSync } from "@xynogen/pix-runtime/atomic-write";
import { homeDir, projectDir } from "@xynogen/pix-runtime/paths";
import { getAgentPath } from "./agent-dir.ts";
import type {
	ImportKind,
	McpConfig,
	McpExposure,
	McpSettings,
	ServerEntry,
	ServerProvenance,
} from "./types.ts";
import { getToolExposure, normalizeExposure } from "./types.ts";

const GENERIC_GLOBAL_CONFIG_PATH = join(homeDir(), ".config", "mcp", "mcp.json");
const PROJECT_CONFIG_NAME = ".mcp.json";
const PROJECT_PI_CONFIG_NAME = `${projectDir()}/mcp.json`;
const REPOPROMPT_BINARY_CANDIDATES = [
	join(homeDir(), "RepoPrompt", "repoprompt_cli"),
	"/Applications/Repo Prompt.app/Contents/MacOS/repoprompt-mcp",
];

const IMPORT_PATHS: Record<ImportKind, string[]> = {
	cursor: [join(homeDir(), ".cursor", "mcp.json")],
	"claude-code": [
		join(homeDir(), ".claude", "mcp.json"),
		join(homeDir(), ".claude.json"),
		join(homeDir(), ".claude", "claude_desktop_config.json"),
	],
	"claude-desktop": [
		join(homeDir(), "Library", "Application Support", "Claude", "claude_desktop_config.json"),
	],
	codex: [join(homeDir(), ".codex", "config.json")],
	windsurf: [join(homeDir(), ".windsurf", "mcp.json")],
	vscode: [".vscode/mcp.json"],
};

interface ConfigSourceSpec {
	id: "shared-global" | "pi-global" | "shared-project" | "pi-project";
	label: string;
	readPath: string;
	writePath: string;
	kind: "user" | "project" | "import";
	importKind?: string;
	shared: boolean;
	scope: "global" | "project";
}

export interface ConfigDiscoveryPath {
	label: string;
	path: string;
	exists: boolean;
}

export interface DiscoveredImportConfig {
	kind: ImportKind;
	path: string;
}

export interface ConfigDiscoverySource extends ConfigDiscoveryPath {
	id: ConfigSourceSpec["id"];
	scope: ConfigSourceSpec["scope"];
	kind: "shared" | "pi";
	serverCount: number;
}

export interface ImportConfigSummary extends DiscoveredImportConfig {
	serverCount: number;
}

export interface RepoPromptDiscovery {
	configured: boolean;
	configuredPath?: string;
	executablePath?: string;
	targetPath?: string;
	serverName?: string;
	entry?: ServerEntry;
}

export interface McpDiscoverySummary {
	sources: ConfigDiscoverySource[];
	imports: ImportConfigSummary[];
	hasAnyConfig: boolean;
	hasAnyDetectedPaths: boolean;
	hasSharedServers: boolean;
	hasPiOwnedServers: boolean;
	totalServerCount: number;
	fingerprint: string;
	repoPrompt: RepoPromptDiscovery;
}

export interface ConfigWritePreview {
	path: string;
	existed: boolean;
	changed: boolean;
	beforeText: string;
	afterText: string;
	diffText: string;
}

export function getPiGlobalConfigPath(overridePath?: string): string {
	return overridePath ? resolve(overridePath) : getAgentPath("mcp.json");
}

export function getGenericGlobalConfigPath(): string {
	return GENERIC_GLOBAL_CONFIG_PATH;
}

export function getProjectConfigPath(cwd = process.cwd()): string {
	return resolve(cwd, PROJECT_CONFIG_NAME);
}

export function getProjectPiConfigPath(cwd = process.cwd()): string {
	return resolve(cwd, PROJECT_PI_CONFIG_NAME);
}

export function getConfigDiscoveryPaths(
	overridePath?: string,
	cwd = process.cwd(),
): ConfigDiscoveryPath[] {
	return getConfigSources(overridePath, cwd).map((source) => ({
		label: source.label,
		path: source.readPath,
		exists: existsSync(source.readPath),
	}));
}

export function findAvailableImportConfigs(cwd = process.cwd()): DiscoveredImportConfig[] {
	const discovered: DiscoveredImportConfig[] = [];

	for (const importKind of Object.keys(IMPORT_PATHS) as ImportKind[]) {
		const importPath = resolveImportPath(importKind, cwd);
		if (importPath) {
			discovered.push({ kind: importKind, path: importPath });
		}
	}

	return discovered;
}

export function getMcpDiscoverySummary(
	overridePath?: string,
	cwd = process.cwd(),
): McpDiscoverySummary {
	const sources = getConfigSources(overridePath, cwd).map((source) => {
		const loaded = readValidatedConfig(source.readPath, `MCP config from ${source.readPath}`);
		return {
			id: source.id,
			label: source.label,
			path: source.readPath,
			exists: existsSync(source.readPath),
			scope: source.scope,
			kind: source.shared ? "shared" : "pi",
			serverCount: loaded ? Object.keys(loaded.mcpServers).length : 0,
		} satisfies ConfigDiscoverySource;
	});

	const imports = (Object.keys(IMPORT_PATHS) as ImportKind[])
		.map((kind) => {
			const path = resolveImportPath(kind, cwd);
			if (!path) return null;
			return {
				kind,
				path,
				serverCount: getImportServerCount(kind, path),
			} satisfies ImportConfigSummary;
		})
		.filter((value): value is ImportConfigSummary => value !== null);

	const totalServerCount = sources.reduce((sum, source) => sum + source.serverCount, 0);
	const hasSharedServers = sources.some(
		(source) => source.kind === "shared" && source.serverCount > 0,
	);
	const hasPiOwnedServers = sources.some(
		(source) => source.kind === "pi" && source.serverCount > 0,
	);
	const hasAnyDetectedPaths = sources.some((source) => source.exists) || imports.length > 0;
	const hasAnyConfig =
		totalServerCount > 0 || imports.some((entry) => entry.serverCount > 0) || hasAnyDetectedPaths;

	const summaryWithoutRepoPrompt = {
		sources,
		imports,
		hasAnyConfig,
		hasAnyDetectedPaths,
		hasSharedServers,
		hasPiOwnedServers,
		totalServerCount,
	};

	const fingerprint = JSON.stringify({
		sources: sources.map((source) => [source.id, source.exists, source.serverCount]),
		imports: imports.map((entry) => [entry.kind, entry.path, entry.serverCount]),
	});

	return {
		...summaryWithoutRepoPrompt,
		fingerprint,
		repoPrompt: detectRepoPrompt(summaryWithoutRepoPrompt, cwd),
	};
}

export function loadMcpConfig(
	overridePath?: string,
	cwd = process.cwd(),
	options: { includeDisabled?: boolean } = {},
): McpConfig {
	let config: McpConfig = { mcpServers: {} };
	let piGlobal: Record<string, ServerEntry> = {};

	for (const source of getConfigSources(overridePath, cwd)) {
		const loaded = readValidatedConfig(source.readPath, `MCP config from ${source.readPath}`);
		if (!loaded) continue;
		if (source.id === "pi-global") piGlobal = loaded.mcpServers;
		config = mergeConfigs(config, expandImports(loaded, cwd));
	}

	return applyPiServerFields(config, piGlobal, options.includeDisabled);
}

// Pi mcp.json values pix-mcp drops. Each is reported once per process.
const reportedUnsupported = new Set<string>();
let pendingUnsupported: string[] = [];

/** Drain "server: field" notes for values that are dropped. The caller shows them TUI-safe. */
export function takeUnsupportedConfigNotes(): string[] {
	const out = pendingUnsupported;
	pendingUnsupported = [];
	return out;
}

function noteUnsupported(note: string): void {
	if (reportedUnsupported.has(note)) return;
	reportedUnsupported.add(note);
	pendingUnsupported.push(note);
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Pi rule: a provider token goes only to https, or to http on a loopback host. */
function isSafeProviderUrl(url: string | undefined): boolean {
	if (!url || !URL.canParse(url)) return false;
	const parsed = new URL(url);
	return (
		parsed.protocol === "https:" ||
		(parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname))
	);
}

/**
 * Apply the Pi mcp.json server fields:
 * - `enabled: false` drops the server, unless `includeDisabled` (the /mcp panel lists it).
 * - `exposure` / `toolExposure` aliases resolve. Invalid values are dropped and noted.
 * - `auth: { provider }` stays only when the Pi global mcp.json sets it for the same URL.
 *   A project or imported file cannot choose where a login token goes.
 */
export function applyPiServerFields(
	config: McpConfig,
	piGlobal: Record<string, ServerEntry> = {},
	includeDisabled = false,
): McpConfig {
	const mcpServers: Record<string, ServerEntry> = {};
	for (const [name, original] of Object.entries(config.mcpServers)) {
		if (original.enabled === false && !includeDisabled) continue;
		const entry: ServerEntry = { ...original };
		// Pi rejects these types. Drop the bad field and note it, so one typo cannot crash the load.
		if (entry.description !== undefined && typeof entry.description !== "string") {
			noteUnsupported(`${name}: description must be a string`);
			delete entry.description;
		}
		if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") {
			noteUnsupported(`${name}: enabled must be a boolean`);
			delete entry.enabled;
		}
		if (
			entry.timeout !== undefined &&
			!(typeof entry.timeout === "number" && Number.isFinite(entry.timeout) && entry.timeout > 0)
		) {
			noteUnsupported(`${name}: timeout must be a positive number of seconds`);
			delete entry.timeout;
		}
		if (entry.exposure !== undefined) {
			const exposure = normalizeExposure(entry.exposure);
			if (!exposure) noteUnsupported(`${name}: exposure "${String(entry.exposure)}"`);
			entry.exposure = exposure;
		}
		if (entry.toolExposure !== undefined) {
			const resolved: Record<string, McpExposure> = {};
			for (const [tool, value] of Object.entries(entry.toolExposure ?? {})) {
				const exposure = normalizeExposure(value);
				if (exposure) resolved[tool] = exposure;
				else noteUnsupported(`${name}: toolExposure "${tool}"`);
			}
			entry.toolExposure = resolved;
		}
		if (typeof entry.auth === "object") {
			const provider = entry.auth?.provider;
			const global = piGlobal[name];
			const fromGlobal =
				typeof global?.auth === "object" &&
				global.auth?.provider === provider &&
				global.url === entry.url;
			if (typeof provider !== "string" || !provider) {
				noteUnsupported(`${name}: auth.provider must be a provider name`);
				delete entry.auth;
			} else if (!fromGlobal) {
				noteUnsupported(`${name}: auth.provider is only allowed in the global Pi mcp.json`);
				delete entry.auth;
			} else if (!isSafeProviderUrl(entry.url)) {
				noteUnsupported(`${name}: auth.provider needs https, or http on localhost`);
				delete entry.auth;
			}
		}
		mcpServers[name] = entry;
	}
	return { ...config, mcpServers };
}

function getConfigSources(overridePath?: string, cwd = process.cwd()): ConfigSourceSpec[] {
	const userPath = getPiGlobalConfigPath(overridePath);
	const projectPath = getProjectConfigPath(cwd);
	const projectPiPath = getProjectPiConfigPath(cwd);
	const sources: ConfigSourceSpec[] = [];

	if (GENERIC_GLOBAL_CONFIG_PATH !== userPath) {
		sources.push({
			id: "shared-global",
			label: "user-global standard MCP",
			readPath: GENERIC_GLOBAL_CONFIG_PATH,
			writePath: userPath,
			kind: "import",
			importKind: "global MCP config",
			shared: true,
			scope: "global",
		});
	}

	sources.push({
		id: "pi-global",
		label: "Pi global override",
		readPath: userPath,
		writePath: userPath,
		kind: "user",
		shared: false,
		scope: "global",
	});

	if (projectPath !== userPath) {
		sources.push({
			id: "shared-project",
			label: "project standard MCP",
			readPath: projectPath,
			writePath: projectPath,
			kind: "project",
			shared: true,
			scope: "project",
		});
	}

	if (projectPiPath !== userPath && projectPiPath !== projectPath) {
		sources.push({
			id: "pi-project",
			label: "project Pi override",
			readPath: projectPiPath,
			writePath: projectPiPath,
			kind: "project",
			shared: false,
			scope: "project",
		});
	}

	return sources;
}

function mergeConfigs(base: McpConfig, next: McpConfig): McpConfig {
	return {
		mcpServers: mergeServerMaps(base.mcpServers, next.mcpServers),
		imports: mergeImports(base.imports, next.imports),
		settings: next.settings ? { ...base.settings, ...next.settings } : base.settings,
	};
}

function mergeServerMaps(
	base: Record<string, ServerEntry>,
	next: Record<string, ServerEntry>,
): Record<string, ServerEntry> {
	const merged = { ...base };
	for (const [name, definition] of Object.entries(next)) {
		merged[name] = { ...(merged[name] ?? {}), ...definition };
	}
	return merged;
}

function mergeImports(
	left: ImportKind[] | undefined,
	right: ImportKind[] | undefined,
): ImportKind[] | undefined {
	const merged = [...(left ?? []), ...(right ?? [])];
	if (merged.length === 0) return undefined;
	return [...new Set(merged)];
}

function expandImports(config: McpConfig, cwd = process.cwd()): McpConfig {
	if (!config.imports?.length) return config;

	const importedServers: Record<string, ServerEntry> = {};
	for (const importKind of config.imports) {
		const importPath = resolveImportPath(importKind, cwd);
		if (!importPath) continue;

		try {
			const imported = JSON.parse(readFileSync(importPath, "utf-8"));
			const servers = extractServers(imported, importKind);
			for (const [name, definition] of Object.entries(servers)) {
				if (!importedServers[name]) {
					importedServers[name] = definition;
				}
			}
		} catch (error) {
			console.warn(`Failed to import MCP config from ${importKind}:`, error);
		}
	}

	return {
		imports: config.imports,
		settings: config.settings,
		mcpServers: mergeServerMaps(importedServers, config.mcpServers),
	};
}

function resolveImportPath(importKind: ImportKind, cwd = process.cwd()): string | null {
	const candidates = IMPORT_PATHS[importKind] ?? [];
	for (const candidate of candidates) {
		const fullPath = candidate.startsWith(".") ? resolve(cwd, candidate) : candidate;
		if (existsSync(fullPath)) {
			return fullPath;
		}
	}
	return null;
}

function getImportServerCount(importKind: ImportKind, path: string): number {
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		return Object.keys(extractServers(raw, importKind)).length;
	} catch {
		return 0;
	}
}

function readValidatedConfig(path: string, label: string): McpConfig | null {
	if (!existsSync(path)) return null;

	try {
		return validateConfig(JSON.parse(readFileSync(path, "utf-8")));
	} catch (error) {
		console.warn(`Failed to load ${label}:`, error);
		return null;
	}
}

function validateConfig(raw: unknown): McpConfig {
	if (!raw || typeof raw !== "object") {
		return { mcpServers: {} };
	}

	const obj = raw as Record<string, unknown>;
	const servers = obj.mcpServers ?? obj["mcp-servers"] ?? {};

	if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
		return { mcpServers: {} };
	}

	return {
		mcpServers: servers as Record<string, ServerEntry>,
		imports: Array.isArray(obj.imports) ? (obj.imports as ImportKind[]) : undefined,
		settings: obj.settings as McpSettings | undefined,
	};
}

function extractServers(config: unknown, kind: ImportKind): Record<string, ServerEntry> {
	if (!config || typeof config !== "object") return {};

	const obj = config as Record<string, unknown>;

	let servers: unknown;
	switch (kind) {
		case "claude-desktop":
		case "claude-code":
		case "codex":
			servers = obj.mcpServers;
			break;
		case "cursor":
		case "windsurf":
		case "vscode":
			servers = obj.mcpServers ?? obj["mcp-servers"];
			break;
		default:
			return {};
	}

	if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
		return {};
	}

	return servers as Record<string, ServerEntry>;
}

function serializeRawConfig(raw: Record<string, unknown>): string {
	return `${JSON.stringify(raw, null, 2)}\n`;
}

function buildUnifiedDiff(beforeText: string, afterText: string): string {
	if (beforeText === afterText) return "(no changes)";

	const before = beforeText.split("\n");
	const after = afterText.split("\n");
	const rows = before.length;
	const cols = after.length;
	const lcs = Array.from({ length: rows + 1 }, () => Array<number>(cols + 1).fill(0));

	for (let i = rows - 1; i >= 0; i--) {
		for (let j = cols - 1; j >= 0; j--) {
			lcs[i][j] =
				before[i] === after[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
		}
	}

	const lines: string[] = ["--- before", "+++ after"];
	let i = 0;
	let j = 0;
	while (i < rows || j < cols) {
		if (i < rows && j < cols && before[i] === after[j]) {
			lines.push(`  ${before[i]}`);
			i++;
			j++;
			continue;
		}
		if (j < cols && (i === rows || lcs[i][j + 1] >= lcs[i + 1][j])) {
			lines.push(`+ ${after[j]}`);
			j++;
			continue;
		}
		if (i < rows) {
			lines.push(`- ${before[i]}`);
			i++;
		}
	}

	return lines.join("\n");
}

function buildConfigWritePreview(
	filePath: string,
	nextRaw: Record<string, unknown>,
): ConfigWritePreview {
	const existed = existsSync(filePath);
	const beforeRaw = readRawConfigObject(filePath);
	const beforeText = existed ? serializeRawConfig(beforeRaw) : "";
	const afterText = serializeRawConfig(nextRaw);
	return {
		path: filePath,
		existed,
		changed: beforeText !== afterText,
		beforeText,
		afterText,
		diffText: buildUnifiedDiff(beforeText, afterText),
	};
}

function readRawConfigObject(filePath: string): Record<string, unknown> {
	if (!existsSync(filePath)) return {};

	try {
		const raw = JSON.parse(readFileSync(filePath, "utf-8"));
		return raw && typeof raw === "object" && !Array.isArray(raw)
			? (raw as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

const writeRawConfigObject = (filePath: string, raw: Record<string, unknown>): void =>
	writeFileAtomicSync(filePath, `${JSON.stringify(raw, null, 2)}\n`);

function getServersObject(raw: Record<string, unknown>): Record<string, ServerEntry> {
	const existing = raw.mcpServers ?? raw["mcp-servers"] ?? {};
	if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
		return {};
	}
	return existing as Record<string, ServerEntry>;
}

function setServersObject(
	raw: Record<string, unknown>,
	servers: Record<string, ServerEntry>,
): void {
	delete raw["mcp-servers"];
	raw.mcpServers = servers;
}

function isRepoPromptServer(name: string, entry: ServerEntry): boolean {
	const normalizedName = name.toLowerCase();
	if (normalizedName.includes("repoprompt") || normalizedName === "rp") {
		return true;
	}

	const command = entry.command?.toLowerCase() ?? "";
	if (
		command.includes("repoprompt") ||
		command.includes("rp-mcp") ||
		command.endsWith("repoprompt_cli")
	) {
		return true;
	}

	return (entry.args ?? []).some(
		(arg) => typeof arg === "string" && arg.toLowerCase().includes("repoprompt"),
	);
}

function findProjectRoot(cwd = process.cwd()): string | null {
	let current = resolve(cwd);
	while (true) {
		if (
			existsSync(join(current, ".git")) ||
			existsSync(join(current, "package.json")) ||
			existsSync(join(current, PROJECT_CONFIG_NAME)) ||
			existsSync(projectDir(current))
		) {
			return current;
		}

		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

function buildRepoPromptEntry(executablePath: string): ServerEntry {
	return {
		command: executablePath,
		args: [],
		lifecycle: "lazy",
	};
}

function detectRepoPrompt(
	summary: Omit<McpDiscoverySummary, "fingerprint" | "repoPrompt">,
	cwd = process.cwd(),
): RepoPromptDiscovery {
	for (const source of summary.sources) {
		if (source.kind !== "shared" || source.serverCount === 0) continue;
		const config = readValidatedConfig(source.path, `MCP config from ${source.path}`);
		if (!config) continue;
		for (const [name, entry] of Object.entries(config.mcpServers)) {
			if (isRepoPromptServer(name, entry)) {
				return { configured: true, configuredPath: source.path };
			}
		}
	}

	const executablePath = REPOPROMPT_BINARY_CANDIDATES.find((candidate) => existsSync(candidate));
	if (!executablePath) {
		return { configured: false };
	}

	const projectRoot = findProjectRoot(cwd);
	const targetPath = projectRoot
		? join(projectRoot, PROJECT_CONFIG_NAME)
		: GENERIC_GLOBAL_CONFIG_PATH;
	return {
		configured: false,
		executablePath,
		targetPath,
		serverName: "repoprompt",
		entry: buildRepoPromptEntry(executablePath),
	};
}

export function previewCompatibilityImports(
	importKinds: ImportKind[],
	overridePath?: string,
): ConfigWritePreview {
	const targetPath = getPiGlobalConfigPath(overridePath);
	const raw = readRawConfigObject(targetPath);
	const currentImports = Array.isArray(raw.imports)
		? raw.imports.filter((value): value is ImportKind => typeof value === "string")
		: [];
	const merged = [...new Set([...currentImports, ...importKinds])];
	const nextRaw = { ...raw, imports: merged };
	setServersObject(nextRaw, getServersObject(nextRaw));
	return buildConfigWritePreview(targetPath, nextRaw);
}

export function ensureCompatibilityImports(
	importKinds: ImportKind[],
	overridePath?: string,
): { path: string; added: ImportKind[] } {
	const targetPath = getPiGlobalConfigPath(overridePath);
	const raw = readRawConfigObject(targetPath);
	const currentImports = Array.isArray(raw.imports)
		? raw.imports.filter((value): value is ImportKind => typeof value === "string")
		: [];
	const merged = [...new Set([...currentImports, ...importKinds])];
	const added = merged.filter((kind) => !currentImports.includes(kind));
	if (added.length === 0) {
		return { path: targetPath, added: [] };
	}

	raw.imports = merged;
	const servers = getServersObject(raw);
	setServersObject(raw, servers);
	writeRawConfigObject(targetPath, raw);
	return { path: targetPath, added };
}

export function buildStarterProjectConfig(): McpConfig {
	return {
		mcpServers: {},
	};
}

export function previewStarterProjectConfig(cwd = process.cwd()): ConfigWritePreview {
	const targetPath = getProjectConfigPath(cwd);
	const nextRaw = { mcpServers: buildStarterProjectConfig().mcpServers };
	return buildConfigWritePreview(targetPath, nextRaw);
}

export function writeStarterProjectConfig(cwd = process.cwd()): string {
	const targetPath = getProjectConfigPath(cwd);
	const raw = { mcpServers: buildStarterProjectConfig().mcpServers };
	writeRawConfigObject(targetPath, raw);
	return targetPath;
}

export function previewSharedServerEntry(
	filePath: string,
	serverName: string,
	entry: ServerEntry,
): ConfigWritePreview {
	const raw = readRawConfigObject(filePath);
	const nextRaw = { ...raw };
	const servers = getServersObject(nextRaw);
	servers[serverName] = entry;
	setServersObject(nextRaw, servers);
	return buildConfigWritePreview(filePath, nextRaw);
}

export function writeSharedServerEntry(
	filePath: string,
	serverName: string,
	entry: ServerEntry,
): string {
	const raw = readRawConfigObject(filePath);
	const servers = getServersObject(raw);
	servers[serverName] = entry;
	setServersObject(raw, servers);
	writeRawConfigObject(filePath, raw);
	return filePath;
}

export function previewRemoveServerEntry(filePath: string, serverName: string): ConfigWritePreview {
	const raw = readRawConfigObject(filePath);
	const nextRaw = { ...raw };
	const servers = { ...getServersObject(nextRaw) };
	delete servers[serverName];
	setServersObject(nextRaw, servers);
	return buildConfigWritePreview(filePath, nextRaw);
}

export function removeServerEntry(filePath: string, serverName: string): string {
	const raw = readRawConfigObject(filePath);
	const servers = getServersObject(raw);
	delete servers[serverName];
	setServersObject(raw, servers);
	writeRawConfigObject(filePath, raw);
	return filePath;
}

export function getServerProvenance(
	overridePath?: string,
	cwd = process.cwd(),
): Map<string, ServerProvenance> {
	const provenance = new Map<string, ServerProvenance>();
	const userPath = getPiGlobalConfigPath(overridePath);

	for (const source of getConfigSources(overridePath, cwd)) {
		const loaded = readValidatedConfig(source.readPath, `MCP config from ${source.readPath}`);
		if (!loaded) continue;

		if (loaded.imports?.length) {
			for (const importKind of loaded.imports) {
				const importPath = resolveImportPath(importKind, cwd);
				if (!importPath) continue;

				try {
					const imported = JSON.parse(readFileSync(importPath, "utf-8"));
					const servers = extractServers(imported, importKind);
					for (const name of Object.keys(servers)) {
						if (!provenance.has(name)) {
							provenance.set(name, { path: userPath, kind: "import", importKind });
						}
					}
				} catch {}
			}
		}

		for (const name of Object.keys(loaded.mcpServers)) {
			provenance.set(name, {
				path: source.writePath,
				kind: source.kind,
				importKind: source.importKind,
			});
		}
	}

	return provenance;
}

// ── /mcp add helpers ───────────────────────────────────────────────────────
export type AddServerScope = "global" | "project";
export type AddServerType = "stdio" | "npx" | "http" | "sse";
export interface AddServerInput {
	name: string;
	type: AddServerType;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	pkg?: string;
	url?: string;
	headers?: Record<string, string>;
	bearerToken?: string;
	bearerTokenEnv?: string;
}
export function resolveAddTargetPath(
	scope: AddServerScope,
	cwd = process.cwd(),
	overridePath?: string,
): string {
	return scope === "global" ? getPiGlobalConfigPath(overridePath) : getProjectConfigPath(cwd);
}
export function buildAddServerEntry(input: AddServerInput): ServerEntry {
	if (input.type === "npx") {
		return {
			command: "npx",
			args: ["-y", input.pkg?.trim() ?? "", ...(input.args ?? [])].filter(Boolean),
			env: input.env,
			cwd: input.cwd || undefined,
		};
	}
	if (input.type === "http" || input.type === "sse") {
		const entry: ServerEntry = { url: input.url?.trim() };
		if (input.headers && Object.keys(input.headers).length > 0) entry.headers = input.headers;
		if (input.bearerToken?.trim()) entry.bearerToken = input.bearerToken.trim();
		if (input.bearerTokenEnv?.trim()) entry.bearerTokenEnv = input.bearerTokenEnv.trim();
		return entry;
	}
	return {
		command: input.command?.trim() ?? "",
		args: input.args ?? [],
		env: input.env,
		cwd: input.cwd || undefined,
	};
}
export function validateAddServerInput(
	input: AddServerInput,
): { ok: true; entry: ServerEntry } | { ok: false; error: string } {
	const name = input.name.trim();
	if (!name) return { ok: false, error: "Server name is required." };
	if (!/^[A-Za-z0-9._-]+$/.test(name))
		return { ok: false, error: "Name may use letters, digits, dot, dash, underscore only." };
	if (input.type === "npx") {
		if (!input.pkg?.trim()) return { ok: false, error: "Package name is required for npx type." };
	} else if (input.type === "stdio") {
		if (!input.command?.trim()) return { ok: false, error: "Command is required for stdio type." };
	} else {
		const url = input.url?.trim() ?? "";
		if (!url) return { ok: false, error: "URL is required for HTTP/SSE type." };
		try {
			const parsed = new URL(url);
			if (!/^https?:$/.test(parsed.protocol)) throw new Error("bad protocol");
		} catch {
			return { ok: false, error: "URL must be http(s)://…" };
		}
	}
	return { ok: true, entry: buildAddServerEntry({ ...input, name }) };
}
export function previewAddServerEntry(
	targetPath: string,
	serverName: string,
	entry: ServerEntry,
): ConfigWritePreview {
	return previewSharedServerEntry(targetPath, serverName, entry);
}
export function writeAddServerEntry(
	targetPath: string,
	serverName: string,
	entry: ServerEntry,
): string {
	return writeSharedServerEntry(targetPath, serverName, entry);
}
export function isServerNameTaken(
	name: string,
	overridePath?: string,
	cwd = process.cwd(),
): boolean {
	const cfg = loadMcpConfig(overridePath, cwd, { includeDisabled: true });
	return name in cfg.mcpServers;
}
/**
 * Apply a /mcp direct-tools choice. A server that uses Pi `exposure` gets per-tool
 * `toolExposure` entries (`direct`, else `codemode`), because exposure wins over `directTools`.
 * Other servers keep the legacy `directTools` field.
 */
export function withDirectChoice(
	entry: ServerEntry,
	value: true | string[] | false,
	toolNames: string[],
): ServerEntry {
	if (entry.exposure === undefined && entry.toolExposure === undefined) {
		return { ...entry, directTools: value };
	}
	const toolExposure: Record<string, McpExposure> = { ...entry.toolExposure };
	for (const tool of toolNames) {
		const direct = value === true || (Array.isArray(value) && value.includes(tool));
		if (direct) toolExposure[tool] = "direct";
		else if (getToolExposure(entry, tool) === "direct") toolExposure[tool] = "codemode";
	}
	return { ...entry, toolExposure };
}

export function writeDirectToolsConfig(
	changes: Map<string, true | string[] | false>,
	provenance: Map<string, ServerProvenance>,
	fullConfig: McpConfig,
	/** Visible tool names per server. Needed to write `toolExposure` for exposure servers. */
	toolNames?: Map<string, string[]>,
): void {
	const byPath = new Map<
		string,
		{ name: string; value: true | string[] | false; prov: ServerProvenance }[]
	>();

	for (const [serverName, value] of changes) {
		const prov = provenance.get(serverName);
		if (!prov) continue;

		const targetPath = prov.path;

		if (!byPath.has(targetPath)) byPath.set(targetPath, []);
		byPath.get(targetPath)!.push({ name: serverName, value, prov });
	}

	for (const [filePath, entries] of byPath) {
		const raw = readRawConfigObject(filePath);
		const servers = getServersObject(raw);

		for (const { name, value, prov } of entries) {
			const base = prov.kind === "import" ? fullConfig.mcpServers[name] : servers[name];
			if (!base) continue;
			servers[name] = withDirectChoice(base, value, toolNames?.get(name) ?? []);
		}

		setServersObject(raw, servers);
		writeRawConfigObject(filePath, raw);
	}
}
