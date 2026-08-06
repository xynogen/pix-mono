/**
 * icon-catalog.ts — semantic icon catalog, treated like an l10n message table.
 *
 * Packages must NOT hardcode glyph codepoints. Instead they ask for an icon by
 * its semantic role — `icon("cwd")`, `icon("paste.image")` — and this module
 * resolves it against the single active icon mode, exactly like `t("key")`
 * resolves a translation against the active locale.
 *
 *   catalog:  key -> { nerd, unicode, ascii }    (the "messages")
 *   mode:     "nerd" | "unicode" | "ascii"       (the "locale")
 *   icon(k):  catalog[k][mode]                    (the "t(key)")
 *
 * One global mode governs the whole stack. It is switched via the `/pix`
 * settings command (in pix-data), persisted to `~/.pi/agent/pix.json`
 * (`pretty.icons`), and seeded from the PRETTY_ICONS env var on first load.
 *
 * Why a catalog instead of per-package toggles: reskinning or fixing a
 * missing-glyph ("tofu") problem becomes a one-file edit here, and there is
 * exactly ONE knob (the mode) rather than one env var per package.
 */

/** Presentation modes, in /pix settings cycle order. nerd = Nerd Font PUA glyphs. */
export type IconMode = "nerd" | "unicode" | "ascii";

/** All modes in cycle order. */
export const ICON_MODES: readonly IconMode[] = ["nerd", "unicode", "ascii"];

/** Force text (non-emoji) presentation for symbols that default to emoji. */
const VS = "\uFE0E";

/**
 * The catalog. Each semantic key maps to one glyph per mode.
 *   - nerd:    Nerd Font Private Use Area codepoint (needs a patched font).
 *   - unicode: standard BMP glyph that ships with virtually every monospace
 *              font (no Nerd Font required); +VS to force text presentation.
 *   - ascii:   pure ASCII, renders on literally any terminal.
 *
 * Keys are SEMANTIC ROLES, never glyph names — consumers reference meaning.
 */
const CATALOG = {
	// ── footer / status segments ──────────────────────────────────────────
	model: { nerd: "\u{F06A9}", unicode: `\u25C8${VS}`, ascii: "M" },
	lsp: { nerd: "\u{F0626}", unicode: `\u25C9${VS}`, ascii: "LSP" },
	mcp: { nerd: "\u{F048D}", unicode: `\u25D0${VS}`, ascii: "MCP" },
	cwd: { nerd: "\u{F024B}", unicode: `\u2302${VS}`, ascii: "~" },
	folder: { nerd: "\u{F024B}", unicode: `\u2302${VS}`, ascii: "/" },

	// ── footer indicators (git status, score) ─────────────────────────────
	"git.unstaged": { nerd: "\u2717", unicode: "\u2717", ascii: "x" },
	"git.ahead": { nerd: "\u21E1", unicode: "\u21E1", ascii: "^" },
	"git.behind": { nerd: "\u21E3", unicode: "\u21E3", ascii: "v" },
	"net.in": { nerd: "\u21E1", unicode: "\u21E1", ascii: "in" },
	"net.out": { nerd: "\u21E3", unicode: "\u21E3", ascii: "out" },
	score: { nerd: "\u26A1", unicode: "\u26A1", ascii: "S" },

	// ── misc ──────────────────────────────────────────────────────────────
	ok: { nerd: "\u2713", unicode: "\u2713", ascii: "ok" },
	warn: { nerd: "\u26A0", unicode: "\u26A0", ascii: "!" },
	error: { nerd: "\u2717", unicode: "\u2717", ascii: "x" },

	// ── shared status glyphs (checklists, panels, markers) ────────────────
	// nerd/unicode keep the historical literal so mixed-glyph rows stay
	// aligned; ascii mode swaps in tofu-free tokens. `⚡` (energetic
	// warning/killed/denied) intentionally stays a local literal — it is not
	// part of this set.
	"status.ok": { nerd: "\u2713", unicode: `\u2713${VS}`, ascii: "ok" },
	"status.error": { nerd: "\u2717", unicode: `\u2717${VS}`, ascii: "x" },
	"status.warn": { nerd: "\u26A0", unicode: `\u26A0${VS}`, ascii: "!" },
	"status.pending": { nerd: "\u25CB", unicode: `\u25CB${VS}`, ascii: "o" },
	"status.running": { nerd: "\u25D0", unicode: `\u25D0${VS}`, ascii: "*" },
	"status.active": { nerd: "\u25CF", unicode: `\u25CF${VS}`, ascii: "*" },
	"status.done": { nerd: "\u25CF", unicode: `\u25CF${VS}`, ascii: "x" },
	"status.blocked": { nerd: "\u2298", unicode: `\u2298${VS}`, ascii: "!" },

	// ── welcome banner ────────────────────────────────────────────────────
	ready: { nerd: "\u{F0633}", unicode: `\u2713${VS}`, ascii: "ok" },

	// ── paste chips (pix-display) ─────────────────────────────────────────
	"paste.image": { nerd: "\u{F02E9}", unicode: `\u25A3${VS}`, ascii: "img" },
	"paste.text": { nerd: "\u{F027F}", unicode: `\u25A4${VS}`, ascii: "txt" },

	// ── model picker (pix-models) ─────────────────────────────────────────
	"picker.model": { nerd: "\u{F0229}", unicode: `\u25C8${VS}`, ascii: "M" },

	// ── optimizer suite (pix-optimizer) ───────────────────────────────────
	"opt.caveman": { nerd: "\u{F0710}", unicode: `\u2664${VS}`, ascii: "Cv" },
	"opt.rtk": { nerd: "\u{F04E5}", unicode: `\u2661${VS}`, ascii: "Rk" },
	"opt.toon": { nerd: "\u{F05C0}", unicode: `\u2662${VS}`, ascii: "Tn" },
	"opt.ponytail": { nerd: "\u{F0190}", unicode: `\u2667${VS}`, ascii: "Pt" },
	"opt.title": { nerd: "\u{F0DAB}", unicode: `\u25C8${VS}`, ascii: "*" },

	// ── subagent widget (pix-subagent) ────────────────────────────────────
	agent: { nerd: "\u{F0BA0}", unicode: `\u2699${VS}`, ascii: "@" },
	turns: { nerd: "\u{F006A}", unicode: `\u21BB${VS}`, ascii: "~" },
	tools: { nerd: "\u{F1064}", unicode: `\u2692${VS}`, ascii: "T" },
	tokens: { nerd: "\u{F027F}", unicode: `\u25A4${VS}`, ascii: "tk" },
} as const;

/** Every valid semantic icon key. */
export type IconKey = keyof typeof CATALOG;

/** All catalog keys (useful for /pix previews and tests). */
export const ICON_KEYS = Object.keys(CATALOG) as IconKey[];

/**
 * Active mode. Seeded from PRETTY_ICONS env (back-compat: none/off => ascii),
 * then overridden by a persisted choice when the host loads pix.json.
 */
function envMode(): IconMode {
	const raw = (process.env.PRETTY_ICONS ?? "").toLowerCase();
	if (raw === "nerd" || raw === "unicode" || raw === "ascii") return raw;
	if (raw === "none" || raw === "off") return "ascii";
	return "nerd";
}

let activeMode: IconMode = envMode();

/** Current global icon mode. */
export function getIconMode(): IconMode {
	return activeMode;
}

/**
 * Mode-change subscribers. Most consumers resolve icon() at render time and
 * need no notification, but PUSHED-status consumers (e.g. the optimizer cell,
 * drawn once via setStatus) must repaint when the mode flips. They subscribe
 * here; setIconMode fires every callback on an actual change.
 */
type ModeListener = (mode: IconMode) => void;
const listeners = new Set<ModeListener>();

/** Subscribe to global icon-mode changes. Returns an unsubscribe fn. */
export function onIconModeChange(cb: ModeListener): () => void {
	listeners.add(cb);
	return () => listeners.delete(cb);
}

/**
 * Set the global icon mode (does NOT persist — callers that want persistence
 * use the /pix command, which writes pix.json then calls this). Fires
 * subscribers only on an actual change (no-op re-sets are ignored).
 */
export function setIconMode(mode: IconMode): void {
	if (!ICON_MODES.includes(mode) || mode === activeMode) return;
	activeMode = mode;
	for (const cb of listeners) cb(mode);
}

/**
 * Resolve a semantic icon key to its glyph for the active mode — the `t(key)`
 * of this module. Unknown keys return "" (fail soft: never throw mid-render).
 */
export function icon(key: IconKey): string {
	const entry = CATALOG[key];
	return entry ? entry[activeMode] : "";
}

/** Resolve a key for an explicit mode (used by /pix previews + tests). */
export function iconFor(key: IconKey, mode: IconMode): string {
	const entry = CATALOG[key];
	return entry ? entry[mode] : "";
}
