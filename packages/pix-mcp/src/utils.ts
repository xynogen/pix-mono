import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openTarget } from "@xynogen/pix-runtime/os";
import { expandHome } from "@xynogen/pix-runtime/paths";
import type { McpConfig, ServerEntry } from "./types.ts";

/**
 * Open a URL in `browser` (or the OS default). pix-runtime picks the opener
 * per OS (open / cmd start / xdg-open / wslview) and resolves it through
 * binary.json, so a missing opener reports an install hint.
 */
export async function openUrl(_pi: ExtensionAPI, url: string, browser?: string): Promise<void> {
	await openTarget(url, { app: browser });
}

export async function openPath(_pi: ExtensionAPI, targetPath: string): Promise<void> {
	await openTarget(targetPath);
}

export async function parallelLimit<T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = [];
	let index = 0;

	async function worker() {
		while (index < items.length) {
			const i = index++;
			results[i] = await fn(items[i] as T);
		}
	}

	const workers = Array(Math.min(limit, items.length))
		.fill(null)
		.map(() => worker());
	await Promise.all(workers);
	return results;
}

export function getConfigPathFromArgv(): string | undefined {
	const idx = process.argv.indexOf("--mcp-config");
	if (idx >= 0 && idx + 1 < process.argv.length) {
		return process.argv[idx + 1];
	}
	return undefined;
}

export function interpolateEnvVars(value: string): string {
	return value
		.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "")
		.replace(/\$env:(\w+)/g, (_, name) => process.env[name] ?? "");
}

export function interpolateEnvRecord(
	values: Record<string, string> | undefined,
): Record<string, string> | undefined {
	if (!values) return undefined;

	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(values)) {
		resolved[key] = interpolateEnvVars(value);
	}
	return resolved;
}

export function resolveConfigPath(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;

	return expandHome(interpolateEnvVars(value));
}

export function resolveBearerToken(
	definition: Pick<ServerEntry, "bearerToken" | "bearerTokenEnv">,
): string | undefined {
	if (definition.bearerToken !== undefined) {
		return interpolateEnvVars(definition.bearerToken);
	}
	return definition.bearerTokenEnv ? process.env[definition.bearerTokenEnv] : undefined;
}

export function truncateAtWord(text: string, target: number): string {
	if (!text) return text;
	// Collapse newlines/indent so multiline descriptions render as one clean line.
	text = text.replace(/\s+/g, " ").trim();
	if (text.length <= target) return text;

	const truncated = text.slice(0, target);
	const lastSpace = truncated.lastIndexOf(" ");

	if (lastSpace > target * 0.6) {
		return `${truncated.slice(0, lastSpace)}...`;
	}

	return `${truncated}...`;
}

export function normalizeDirectToolInputSchema(schema: unknown): Record<string, unknown> {
	const inputSchema =
		schema && typeof schema === "object" && !Array.isArray(schema)
			? (schema as Record<string, unknown>)
			: { type: "object", properties: {} };
	const { $schema, additionalProperties, ...normalized } = inputSchema;
	return normalized;
}

export function formatAuthRequiredMessage(
	config: Pick<McpConfig, "settings">,
	serverName: string,
	defaultMessage: string,
): string {
	const template = config.settings?.authRequiredMessage;
	// `${server}` is the documented placeholder syntax for authRequiredMessage.
	return template ? template.replaceAll(`\${server}`, serverName) : defaultMessage;
}

/**
 * Extract the adapter-owned UI stream mode from tool metadata.
 */
export function extractToolUiStreamMode(
	toolMeta: Record<string, unknown> | undefined,
): "eager" | "stream-first" | undefined {
	const uiMeta = toolMeta?.ui;
	if (!uiMeta || typeof uiMeta !== "object") return undefined;
	const streamMode = (uiMeta as Record<string, unknown>)["pi-mcp-adapter.streamMode"];
	if (streamMode === "eager" || streamMode === "stream-first") {
		return streamMode;
	}
	return undefined;
}
