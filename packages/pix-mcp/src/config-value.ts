// config-value.ts - Pi mcp.json `!command` config values.

import { getErrorMessage } from "@xynogen/pix-pretty/utils";
import { runTool } from "@xynogen/pix-runtime/exec";
import type { ServerEntry } from "./types.ts";
import { interpolateEnvRecord } from "./utils.ts";

// ponytail: per-process cache like Pi. A rotated secret needs a Pi restart.
const commandValueCache = new Map<string, Promise<string>>();
const COMMAND_VALUE_TIMEOUT_MS = 10_000;

/**
 * Run a `!cmd` config value once per process and use its trimmed stdout. `bash` comes from the
 * pix-runtime catalog (Git Bash on Windows, the same shell Pi uses). Errors name the server and
 * key, never the output.
 */
export function resolveCommandValue(
	value: string,
	serverName: string,
	key: string,
): Promise<string> {
	let pending = commandValueCache.get(value);
	if (!pending) {
		pending = runTool("bash", ["-c", value.slice(1)], {
			timeoutMs: COMMAND_VALUE_TIMEOUT_MS,
		}).then((result) => {
			if (result.timedOut) throw new Error("timed out");
			if (result.code !== 0) throw new Error(`exit code ${result.code}`);
			const out = result.stdout.trim();
			if (!out) throw new Error("empty output");
			return out;
		});
		commandValueCache.set(value, pending);
		// A failure is not cached, so a fixed command works on the next connect.
		pending.catch(() => commandValueCache.delete(value));
	}
	return pending.catch((error: unknown) => {
		throw new Error(
			`MCP server "${serverName}": command for "${key}" failed (${getErrorMessage(error)})`,
		);
	});
}

/** `${VAR}` interpolation, and `!cmd` values run through {@link resolveCommandValue}. */
export async function resolveConfigRecord(
	values: Record<string, string> | undefined,
	serverName: string,
): Promise<Record<string, string> | undefined> {
	const resolved = interpolateEnvRecord(values);
	if (!values || !resolved) return resolved;
	for (const [key, value] of Object.entries(values)) {
		if (value.startsWith("!")) resolved[key] = await resolveCommandValue(value, serverName, key);
	}
	return resolved;
}

/** The entry with a `!cmd` `oauth.clientSecret` replaced by the command output. */
export async function resolveOAuthSecret(
	definition: ServerEntry,
	serverName: string,
): Promise<ServerEntry> {
	const oauth = definition.oauth;
	if (typeof oauth !== "object" || !oauth.clientSecret?.startsWith("!")) return definition;
	const clientSecret = await resolveCommandValue(
		oauth.clientSecret,
		serverName,
		"oauth.clientSecret",
	);
	return { ...definition, oauth: { ...oauth, clientSecret } };
}
