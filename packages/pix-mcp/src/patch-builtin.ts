import { updatePiSettings } from "@xynogen/pix-runtime/pi-settings";

/**
 * Keep Pi's built-in MCP off for the next load. Returns true when settings changed.
 * ponytail: Settings take effect on the next load. Pi has no command-only switch for built-in MCP.
 */
export function patchOutBuiltinMcp(path?: string): boolean {
	return updatePiSettings(
		(settings) => {
			const extensions = settings.extensions ?? [];
			if (!Array.isArray(extensions) || !extensions.every((item) => typeof item === "string")) {
				throw new Error("Invalid Pi extensions setting");
			}
			if (extensions.includes("-builtin:mcp") || extensions.includes("+builtin:mcp")) return;
			settings.extensions = [...extensions, "-builtin:mcp"];
		},
		{ path },
	);
}
