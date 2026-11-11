/**
 * project-prefs.ts — persist model/provider/thinking per project.
 *
 * All three prefs live together in Pi's own project settings file
 * (`<cwd>/.pi/settings.json`). Pi deep-merges that file over the user-level
 * `<agentDir>/settings.json` at startup, so projects without their own prefs
 * fall back to the user defaults with no extra loader.
 *
 * Untrusted projects (Pi refuses to read their settings) and a cwd whose
 * `.pi` IS the user config root (cwd === home) write the user-level file.
 */

import { dirname, join, resolve } from "node:path";
import { showTransientMessage } from "@xynogen/pix-pretty/transient-error";
import { getErrorMessage } from "@xynogen/pix-pretty/utils";
import { writeFileAtomicSync } from "@xynogen/pix-runtime/atomic-write";
import { existsSync, readFileSync } from "@xynogen/pix-runtime/fs";
import type { ExtensionAPI, ExtensionContext } from "@xynogen/pix-runtime/host";
import { agentDir, projectDir, projectPath, projectRel } from "@xynogen/pix-runtime/paths";

export type ModelPrefs = {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: string;
};

export type PrefsTarget = { path: string; scope: "project" | "user" };

/** Pick the settings file that should own this cwd's prefs. */
export function prefsTarget(cwd: string, trusted: boolean, agent = agentDir()): PrefsTarget {
	const userFile = join(agent, "settings.json");
	const project = projectDir(resolve(cwd));
	// cwd/.pi is the parent of the agent dir → "project" file would be ~/.pi/settings.json,
	// which is confusing and not a real project. Use the user file instead.
	if (!trusted || resolve(project) === resolve(dirname(agent))) {
		return { path: userFile, scope: "user" };
	}
	return { path: projectPath(resolve(cwd), "settings.json"), scope: "project" };
}

/** Merge `prefs` into the JSON settings file at `path`. Returns true if it changed. */
export function writePrefs(path: string, prefs: ModelPrefs): boolean {
	let current: Record<string, unknown> = {};
	if (existsSync(path)) {
		const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
		if (raw.trim()) {
			const parsed: unknown = JSON.parse(raw);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				current = parsed as Record<string, unknown>;
			}
		}
	}
	let changed = false;
	for (const [key, value] of Object.entries(prefs)) {
		if (value !== undefined && current[key] !== value) {
			current[key] = value;
			changed = true;
		}
	}
	if (changed) writeFileAtomicSync(path, `${JSON.stringify(current, null, 2)}\n`, 0o644);
	return changed;
}

/** Save prefs for ctx.cwd and surface where they went. */
export function savePrefs(
	ctx: ExtensionContext,
	prefs: ModelPrefs,
	label: string,
): PrefsTarget | undefined {
	const target = prefsTarget(ctx.cwd, ctx.isProjectTrusted());
	try {
		if (writePrefs(target.path, prefs) && ctx.hasUI) {
			const where = target.scope === "project" ? projectRel("settings.json") : "user settings.json";
			showTransientMessage(ctx.ui, `${label} saved to ${where}`, "info");
		}
		return target;
	} catch (err) {
		if (ctx.hasUI) {
			const msg = getErrorMessage(err);
			showTransientMessage(ctx.ui, `Failed to save ${label}: ${msg}`, "warning");
		}
		return undefined;
	}
}

/** Persist every user-driven model / thinking change to the owning settings file. */
export function registerProjectPrefs(pi: ExtensionAPI): void {
	pi.on("model_select", (event, ctx) => {
		// "restore" = session resume; not a user choice.
		if (event.source === "restore") return;
		const { provider, id } = event.model;
		savePrefs(ctx, { defaultProvider: provider, defaultModel: id }, `Model ${provider}/${id}`);
	});
	pi.on("thinking_level_select", (event, ctx) => {
		// Non-reasoning models force "off"; don't let that clobber the saved preference.
		if (!ctx.model?.reasoning) return;
		savePrefs(ctx, { defaultThinkingLevel: event.level }, `Thinking ${event.level}`);
	});
}
