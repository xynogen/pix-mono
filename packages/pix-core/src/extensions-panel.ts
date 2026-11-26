/**
 * `/pix` → Extensions: turn pix-core members off, install or remove standalone pix packages.
 * Every change needs a fresh Pi process (/reload keeps runtime patches from the old load).
 * Member toggles are staged: leaving the tab or closing /pix asks once for all of them. Allow
 * writes them and closes Pi; Deny writes nothing.
 */

import { confirmOverlay } from "@xynogen/pix-pretty/confirm";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { type SettingsRow, showSettingsPicker } from "@xynogen/pix-pretty/provider-picker";
import { registerPackageSettings } from "@xynogen/pix-runtime";
import { config, pixRuntime } from "@xynogen/pix-runtime/config";
import { runBinary } from "@xynogen/pix-runtime/exec";
import type { ExtensionAPI, ExtensionCommandContext } from "@xynogen/pix-runtime/host";
import { readPiSettings } from "@xynogen/pix-runtime/pi-settings";
import { extensionsSection } from "@xynogen/pix-runtime/sections";
import {
	GATE,
	installedStandalone,
	LOCKED_MEMBERS,
	memberPackage,
	packageCommand,
	STANDALONE_PACKAGES,
	shortName,
	toggleDisabled,
} from "./extensions-lib.ts";

const PI_TIMEOUT_MS = 180_000;

/**
 * Rows for the panel. `members` are pix-core member specifiers; `disabled` is the saved list and
 * `staged` the list the user is building, shown as the row value with a pending mark.
 */
export function extensionRows(
	members: readonly string[],
	disabled: readonly string[],
	installed: ReadonlyMap<string, string>,
	staged: readonly string[] = disabled,
): SettingsRow[] {
	const rows: SettingsRow[] = [];
	for (const pkg of [...new Set(members.map(memberPackage))]) {
		if (LOCKED_MEMBERS.has(pkg)) {
			rows.push({
				key: `lock:${pkg}`,
				section: "Core",
				label: shortName(pkg),
				value: "always on",
				tone: "muted",
			});
			continue;
		}
		const off = staged.includes(pkg);
		const pending = off !== disabled.includes(pkg) ? " · pending" : "";
		rows.push({
			key: `member:${pkg}`,
			section: "Core",
			label: shortName(pkg),
			value: `${off ? "disabled" : "on"}${pending}`,
			tone: off ? "muted" : "success",
			dim: off,
		});
	}
	for (const pkg of STANDALONE_PACKAGES) {
		const has = installed.has(pkg);
		rows.push({
			key: `${has ? "remove" : "install"}:${pkg}`,
			section: "Packages",
			label: shortName(pkg),
			value: has ? "installed · enter removes" : "not installed · enter installs",
			tone: has ? "success" : "muted",
		});
	}
	return rows;
}

/** `["welcome", "footer"]` as "disable welcome, footer · enable todo". */
function describeChanges(saved: readonly string[], staged: readonly string[]): string {
	const names = (list: string[]) => list.map(shortName).join(", ");
	const off = staged.filter((pkg) => !saved.includes(pkg));
	const on = saved.filter((pkg) => !staged.includes(pkg));
	return [off.length ? `disable ${names(off)}` : "", on.length ? `enable ${names(on)}` : ""]
		.filter(Boolean)
		.join(" · ");
}

/**
 * Ask once for every staged member change. Pi must close to apply them (/reload keeps the old
 * load's patches): Allow writes pix.json and closes Pi, Deny writes nothing. No change, no prompt.
 */
export async function confirmStaged(
	ctx: ExtensionCommandContext,
	staged: readonly string[],
): Promise<void> {
	const saved = config(extensionsSection).disabled;
	const changes = describeChanges(saved, staged);
	if (!changes) return;
	const ok = await confirmOverlay(ctx.ui, {
		icon: icon("status.warn"),
		title: "Apply extension changes?",
		body: [
			changes.charAt(0).toUpperCase() + changes.slice(1),
			...(staged.includes(GATE) && !saved.includes(GATE)
				? ["", "Gate off: dangerous commands run without asking."]
				: []),
			"",
			"Pi closes to apply them: /reload cannot unload an extension.",
			"Start Pi again afterwards. Deny changes nothing.",
		],
		confirmLabel: "Allow — apply and close Pi",
		denyLabel: "Deny — discard changes",
	});
	if (!ok) return;
	await pixRuntime().update(extensionsSection, { disabled: [...staged].sort() });
	ctx.ui.notify(`Extensions: ${changes}. Closing Pi — start it again to apply.`, "warning");
	ctx.shutdown();
}

/** Run `pi install|remove` after the user confirms, then close Pi so the next start loads it. */
async function changePackage(
	ctx: ExtensionCommandContext,
	action: "install" | "remove",
	pkg: string,
	source: string | undefined,
): Promise<void> {
	const args = packageCommand(action, pkg, source);
	const verb = action === "install" ? "install" : "remove";
	const ok = await confirmOverlay(ctx.ui, {
		icon: icon(action === "install" ? "settings" : "status.warn"),
		title: `${action === "install" ? "Install" : "Remove"} ${shortName(pkg)}?`,
		body: [
			`Runs: pi ${args[0]}`,
			`  ${args[1]}`,
			`Changes Pi's settings.json${action === "install" ? " and downloads from npm" : ""}.`,
			"Pi closes when it finishes. Start Pi again afterwards.",
		],
		confirmLabel: `Allow — ${verb} ${shortName(pkg)} and close Pi`,
		denyLabel: "Deny — cancel",
	});
	if (!ok) return;
	const result = await runBinary("pi", args, { timeoutMs: PI_TIMEOUT_MS });
	if (result.code !== 0) {
		const detail = (result.stderr || result.stdout).trim().split("\n").at(-1) ?? "";
		throw new Error(`pi ${args.join(" ")} failed (exit ${result.code}) ${detail}`.trim());
	}
	ctx.ui.notify(
		`${shortName(pkg)} ${action === "install" ? "installed" : "removed"}. Closing Pi — start it again to apply.`,
		"warning",
	);
	ctx.shutdown();
}

export function registerExtensionsPanel(pi: ExtensionAPI, members: readonly string[]): void {
	// Staged member toggles; undefined when nothing is staged. Cleared once confirmed or denied.
	let staged: string[] | undefined;
	registerPackageSettings(pi, {
		id: "pix-core-extensions",
		label: "Extensions",
		open: async (ctx: ExtensionCommandContext) => {
			const installed = () => {
				try {
					return installedStandalone(readPiSettings().packages);
				} catch {
					return new Map<string, string>();
				}
			};
			await showSettingsPicker(ctx.ui, {
				title: `${icon("settings")} Extensions`,
				sectionTabs: true,
				rows: () => {
					const saved = config(extensionsSection).disabled;
					return extensionRows(members, saved, installed(), staged ?? saved);
				},
				status: () => [
					"",
					`  ${ctx.ui.theme.fg("muted", "Leave this tab to apply: confirm once, then Pi closes.")}`,
				],
				onAction: async ({ key }) => {
					const [kind, pkg] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
					if (kind === "member") {
						staged = toggleDisabled(staged ?? config(extensionsSection).disabled, pkg);
					} else if (kind === "install" || kind === "remove") {
						await changePackage(ctx, kind, pkg, installed().get(pkg));
					}
					return undefined;
				},
			});
		},
		onLeave: async (ctx: ExtensionCommandContext) => {
			if (!staged) return;
			const pending = staged;
			staged = undefined;
			await confirmStaged(ctx, pending);
		},
	});
}
