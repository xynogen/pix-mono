import { writeFileAtomicSync } from "@xynogen/pix-runtime/atomic-write";
import { existsSync, readFileSync, statSync } from "@xynogen/pix-runtime/fs";
import { agentDir } from "@xynogen/pix-runtime/paths";

export function patchOutBuiltinMcp(path = `${agentDir()}/settings.json`): boolean {
	const exists = existsSync(path);
	const settings: unknown = exists ? JSON.parse(readFileSync(path, "utf8")) : {};
	if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
		throw new Error(`Invalid Pi settings: ${path}`);
	}
	const config = settings as Record<string, unknown>;
	const extensions = config.extensions ?? [];
	if (!Array.isArray(extensions) || !extensions.every((item) => typeof item === "string")) {
		throw new Error(`Invalid Pi extensions setting: ${path}`);
	}
	if (extensions.includes("-builtin:mcp") || extensions.includes("+builtin:mcp")) return false;

	// ponytail: Settings take effect on the next load. Pi has no command-only switch for built-in MCP.
	writeFileAtomicSync(
		path,
		`${JSON.stringify({ ...config, extensions: [...extensions, "-builtin:mcp"] }, null, 2)}\n`,
		exists ? statSync(path).mode & 0o777 : 0o600,
	);
	return true;
}
