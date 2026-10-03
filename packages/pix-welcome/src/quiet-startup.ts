import { existsSync, readFileSync, statSync } from "node:fs";
import { writeFileAtomicSync } from "@xynogen/pix-runtime/atomic-write";
import { agentDir } from "@xynogen/pix-runtime/paths";

/**
 * Set `quietStartup: true` in Pi settings so the pix banner replaces Pi's
 * built-in startup header and resource listing. An explicit user value wins.
 */
export function patchQuietStartup(path = `${agentDir()}/settings.json`): boolean {
	const exists = existsSync(path);
	const settings: unknown = exists ? JSON.parse(readFileSync(path, "utf8")) : {};
	if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
		throw new Error(`Invalid Pi settings: ${path}`);
	}
	if ("quietStartup" in settings) return false;

	// ponytail: Settings take effect on the next load. Pi reads quietStartup before extensions run.
	writeFileAtomicSync(
		path,
		`${JSON.stringify({ ...settings, quietStartup: true }, null, 2)}\n`,
		exists ? statSync(path).mode & 0o777 : 0o600,
	);
	return true;
}
