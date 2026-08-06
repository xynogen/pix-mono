import { config } from "@xynogen/pix-runtime/config";
import { prettySection } from "@xynogen/pix-runtime/sections";

export function envInt(name: string, fallback: number): number {
	const v = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(v) && v > 0 ? v : fallback;
}

// Precedence for numeric config: env var → pix.json → hardcoded default
function pixOrEnvInt(envName: string, pixValue: number, fallback: number): number {
	const env = process.env[envName];
	if (env) {
		const v = Number.parseInt(env, 10);
		if (Number.isFinite(v) && v > 0) return v;
	}
	return pixValue !== fallback ? pixValue : fallback;
}

const pc = config(prettySection);

export const MAX_HL_CHARS = pixOrEnvInt("PRETTY_MAX_HL_CHARS", pc.maxHighlightChars, 80_000);

// Per-LINE guard. MAX_HL_CHARS caps the whole block, but cli-highlight's
// highlight.js tokenizer backtracks catastrophically on a single very long
// line (a multi-KB JSON string value, a minified one-liner) and freezes the
// render thread. JSON can't be hard-wrapped without splitting values mid-token
// (which breaks highlighting), so a block containing any line past this width
// is returned plain instead. ponytail: fixed threshold; make it a pix.json knob
// only if a real file legitimately needs highlighted lines wider than this.
export const MAX_HL_LINE_CHARS = envInt("PRETTY_MAX_HL_LINE_CHARS", 2_000);

export const MAX_PREVIEW_LINES = pixOrEnvInt("PRETTY_MAX_PREVIEW_LINES", pc.maxPreviewLines, 80);

export const CACHE_LIMIT = pixOrEnvInt("PRETTY_CACHE_LIMIT", pc.cacheLimit, 128);

// --- Diff rendering limits (edit/write tools) ---
export const MAX_RENDER_LINES = pixOrEnvInt("PRETTY_MAX_RENDER_LINES", pc.maxRenderLines, 150);

// Word-level emphasis only when paired del/add lines are at least this similar.
export const WORD_DIFF_MIN_SIM = 0.15;

// ---------------------------------------------------------------------------
// ANSI
// ---------------------------------------------------------------------------
