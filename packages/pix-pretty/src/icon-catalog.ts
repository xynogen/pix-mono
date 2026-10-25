/**
 * icon-catalog.ts — the public icon surface of pix-pretty.
 *
 * The shared catalog lives in `@xynogen/pix-runtime` (a lower layer) so that
 * pix-runtime's own UI — the `/pix` settings overlay — can resolve icons
 * without a circular dependency on pix-pretty. This file re-exports that
 * surface, and adds the display-only icons that pix-pretty owns
 * (`PRETTY_CATALOG`). Both follow the same global icon mode.
 */

import {
	getIconMode,
	type IconMode,
	type IconKey as RuntimeIconKey,
	icon as runtimeIcon,
	iconFor as runtimeIconFor,
} from "@xynogen/pix-runtime/icon-catalog";

export {
	getIconMode,
	ICON_KEYS,
	ICON_MODES,
	type IconMode,
	onIconModeChange,
	setIconMode,
} from "@xynogen/pix-runtime/icon-catalog";

const VS = "\uFE0E"; // force text presentation

/** Icons that pix-pretty owns. Same shape as the runtime catalog. */
const PRETTY_CATALOG = {
	// ── agent mode (pix-core plan mode, footer) ───────────────────────────
	"mode.plan": { nerd: "\u{F034D}", unicode: `\u2630${VS}`, ascii: "P" },
	"mode.normal": { nerd: "\u{F0174}", unicode: `\u276F${VS}`, ascii: ">" },
	// ── model kind (pix-models picker) ─────────────────────────────────────
	"model.classifier": { nerd: "\u{F05D1}", unicode: `\u2696${VS}`, ascii: "C" },
	// ── steering hint (pix-nudge cards): advice, not a warning — keep it off `⚠` ──
	nudge: { nerd: "\u{F0335}", unicode: `\u279C${VS}`, ascii: ">" },
} as const satisfies Record<string, Record<IconMode, string>>;

type PrettyIconKey = keyof typeof PRETTY_CATALOG;

/** Every valid semantic icon key: runtime catalog + pix-pretty catalog. */
export type IconKey = RuntimeIconKey | PrettyIconKey;

/** pix-pretty's own keys (the runtime keys are in `ICON_KEYS`). */
export const PRETTY_ICON_KEYS = Object.keys(PRETTY_CATALOG) as PrettyIconKey[];

function isPrettyKey(key: IconKey): key is PrettyIconKey {
	return Object.hasOwn(PRETTY_CATALOG, key);
}

/** Resolve a semantic icon key to its glyph for the active mode. Unknown keys return "". */
export function icon(key: IconKey): string {
	return isPrettyKey(key) ? PRETTY_CATALOG[key][getIconMode()] : runtimeIcon(key);
}

/** Resolve a key for an explicit mode (used by /pix previews + tests). */
export function iconFor(key: IconKey, mode: IconMode): string {
	return isPrettyKey(key) ? PRETTY_CATALOG[key][mode] : runtimeIconFor(key, mode);
}
