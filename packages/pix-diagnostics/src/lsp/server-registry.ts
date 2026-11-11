/** Project-owned LSP server configuration and root detection. */

import { readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { homeDir, projectPath } from "@xynogen/pix-runtime/paths";
import { findExecutable } from "@xynogen/pix-runtime/which";

export interface LspServerSpec {
	id: string;
	name: string;
	extensions: readonly string[];
	filenames?: readonly string[];
	commands: readonly string[];
	args: readonly string[];
	rootMarkers: readonly string[];
	languageId(filePath: string): string;
}

export interface ResolvedLspServer {
	spec: LspServerSpec;
	command: string;
	root: string;
}

interface ProjectServerConfig {
	command: string;
	args?: string[];
	extensions: string[];
	filenames?: string[];
	languageId: string;
	rootMarkers?: string[];
}

interface ProjectConfig {
	servers: Record<string, ProjectServerConfig>;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isServerConfig(value: unknown): value is ProjectServerConfig {
	if (!value || typeof value !== "object") return false;
	const item = value as Record<string, unknown>;
	return (
		typeof item.command === "string" &&
		isStringArray(item.extensions) &&
		typeof item.languageId === "string" &&
		(item.args === undefined || isStringArray(item.args)) &&
		(item.filenames === undefined || isStringArray(item.filenames)) &&
		(item.rootMarkers === undefined || isStringArray(item.rootMarkers))
	);
}

/** Load only `.pi/lsp.json` from the current project. Invalid entries are ignored. */
export function loadProjectServers(cwd: string): LspServerSpec[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(projectPath(cwd, "lsp.json"), "utf8"));
	} catch {
		return [];
	}
	if (!parsed || typeof parsed !== "object") return [];
	const servers = (parsed as Partial<ProjectConfig>).servers;
	if (!servers || typeof servers !== "object") return [];

	const specs: LspServerSpec[] = [];
	for (const [id, value] of Object.entries(servers)) {
		if (!isServerConfig(value)) continue;
		const languageId = value.languageId;
		specs.push({
			id,
			name: id,
			extensions: value.extensions.map((extension) => extension.toLowerCase()),
			filenames: value.filenames,
			commands: [value.command],
			args: value.args ?? [],
			rootMarkers: value.rootMarkers ?? [".git"],
			languageId: () => languageId,
		});
	}
	return specs;
}

const basename = (filePath: string): string => filePath.split(/[/\\]/).pop() ?? filePath;

function findServerSpec(
	servers: readonly LspServerSpec[],
	filePath: string,
): LspServerSpec | undefined {
	const ext = extname(filePath).toLowerCase();
	const name = basename(filePath).toLowerCase();
	return servers.find(
		(spec) =>
			spec.extensions.includes(ext) ||
			(spec.filenames?.some((filename) => filename.toLowerCase() === name) ?? false),
	);
}

type AccessFn = (path: string) => Promise<boolean>;

const defaultAccess: AccessFn = async (path) => {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
};

export async function rootForFile(
	filePath: string,
	markers: readonly string[],
	canAccess: AccessFn = defaultAccess,
): Promise<string> {
	const start = dirname(resolve(filePath));
	const stop = homeDir();
	let dir = start;
	for (;;) {
		for (const marker of markers) {
			if (await canAccess(join(dir, marker))) return dir;
		}
		const parent = dirname(dir);
		if (parent === dir || dir === stop) break;
		dir = parent;
	}
	return start;
}

export async function resolveServer(
	spec: LspServerSpec,
	root: string,
): Promise<ResolvedLspServer | undefined> {
	const command = await findExecutable(spec.commands[0] ?? "");
	return command ? { spec, command, root } : undefined;
}

export interface Resolver {
	specFor(filePath: string): LspServerSpec | undefined;
	rootFor(filePath: string, spec: LspServerSpec): Promise<string>;
}

export function createResolver(cwd: string): Resolver {
	const servers = loadProjectServers(resolve(cwd));
	return {
		specFor: (filePath) => findServerSpec(servers, filePath),
		rootFor: (filePath, spec) => rootForFile(filePath, spec.rootMarkers),
	};
}
