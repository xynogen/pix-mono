/**
 * pi-settings.ts — read and update Pi's `settings.json` as key/value data.
 *
 * One reader and one atomic writer for every package that keeps a preference in Pi's
 * settings. No UI: callers decide whether and how to tell the user.
 * Not locked across processes: two `pi` processes writing at once can lose one update.
 */

import { join } from "node:path";
import { writeFileAtomicSync } from "./atomic-write.ts";
import { existsSync, readFileSync, statSync } from "./fs.ts";
import { agentDir } from "./paths.ts";

export type PiSettings = Record<string, unknown>;

export type PiSettingsOptions = {
	/** Settings file to use. Default: the user-level `<agentDir>/settings.json`. */
	path?: string;
	/** File mode for a new file. An existing file keeps its mode. Default 0o600. */
	mode?: number;
};

const isRecord = (value: unknown): value is PiSettings =>
	!!value && typeof value === "object" && !Array.isArray(value);

export function piSettingsPath(): string {
	return join(agentDir(), "settings.json");
}

/**
 * Parsed settings, or `{}` for a missing or empty file. A file that is not valid JSON, or
 * not an object, throws: callers must not overwrite what they could not read.
 */
export function readPiSettings(path = piSettingsPath()): PiSettings {
	if (!existsSync(path)) return {};
	const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
	if (!raw.trim()) return {};
	const parsed: unknown = JSON.parse(raw);
	if (!isRecord(parsed)) throw new Error(`Invalid Pi settings: ${path}`);
	return parsed;
}

/**
 * Edit a copy of the settings and write it back only when it changed.
 * `edit` mutates the copy it is given. Returns true when the file was written.
 */
export function updatePiSettings(
	edit: (settings: PiSettings) => void,
	{ path = piSettingsPath(), mode = 0o600 }: PiSettingsOptions = {},
): boolean {
	const current = readPiSettings(path);
	const next = structuredClone(current);
	edit(next);
	const text = `${JSON.stringify(next, null, 2)}\n`;
	if (JSON.stringify(next) === JSON.stringify(current)) return false;
	writeFileAtomicSync(path, text, existsSync(path) ? statSync(path).mode & 0o777 : mode);
	return true;
}

/** Set `target[key]` from `entries`; objects merge key by key. Skips set keys when `onlyMissing`. */
function merge(target: PiSettings, entries: PiSettings, onlyMissing: boolean): void {
	for (const [key, value] of Object.entries(entries)) {
		if (value === undefined) continue;
		const existing = target[key];
		if (isRecord(value) && isRecord(existing)) merge(existing, value, onlyMissing);
		else if (!(onlyMissing && key in target)) target[key] = value;
	}
}

/**
 * Set key/value pairs. Object values merge into an existing object, so
 * `{ markdown: { mermaid: "off" } }` keeps other `markdown` keys. With `onlyMissing`,
 * a key the user already set (even to `false`) is left alone.
 * Returns true when the file changed.
 */
export function setPiSettings(
	entries: PiSettings,
	options: PiSettingsOptions & { onlyMissing?: boolean } = {},
): boolean {
	return updatePiSettings(
		(settings) => merge(settings, entries, options.onlyMissing ?? false),
		options,
	);
}
