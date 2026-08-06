import { normalizeShikiContrast } from "./ansi.js";
import { CACHE_LIMIT, MAX_HL_CHARS, MAX_HL_LINE_CHARS } from "./config.js";
import type { BundledLanguage, FgTheme } from "./types.js";

// Engine: cli-highlight (highlight.js-backed, synchronous ANSI output).
//
// cli-highlight colors via chalk, which decides its color level ONCE based on
// TTY/env detection. Shiki's codeToANSI always emitted truecolor regardless of
// stream; to match that (pi renders highlighted output into its own TUI, which
// is not the process stdout chalk inspects) we default FORCE_COLOR before chalk
// initializes, and lazy-load cli-highlight so this runs first. Respect an
// explicit FORCE_COLOR/NO_COLOR if the user set one.
if (process.env.FORCE_COLOR === undefined && process.env.NO_COLOR === undefined) {
	process.env.FORCE_COLOR = "3";
}

type CliHighlight = typeof import("cli-highlight");

let _hl: CliHighlight | null = null;

// Deterministically force chalk's color level to truecolor. The FORCE_COLOR
// env default above only works if chalk has not been required yet — but if
// ANY transitive dependency loads chalk before this module evaluates, chalk
// freezes its level at 0 (pi's TUI is not a TTY) and cli-highlight emits NO
// ANSI, so read/diff render as plain text. Setting chalk.level after require
// is load-order-independent and fixes that. Respect NO_COLOR.
function forceChalkColor(): void {
	if (process.env.NO_COLOR !== undefined) return;
	try {
		const chalk = require("chalk");
		const c = chalk?.default ?? chalk;
		if (c && typeof c.level === "number" && c.level < 3) c.level = 3;
	} catch {
		/* chalk not resolvable — cli-highlight will fall back gracefully */
	}
}

function cliHighlight(): CliHighlight | null {
	if (_hl) return _hl;
	try {
		forceChalkColor();
		_hl = require("cli-highlight") as CliHighlight;
	} catch {
		_hl = null;
	}
	return _hl;
}

const HLJS_LANG_ALIAS: Record<string, string> = {
	tsx: "typescript",
	jsx: "javascript",
	jsonc: "json",
	mdx: "markdown",
	make: "makefile",
	svelte: "html",
	vue: "html",
};

function toHljsLang(language: BundledLanguage): string | undefined {
	const hl = cliHighlight();
	if (!hl) return undefined;
	const mapped = HLJS_LANG_ALIAS[language] ?? language;
	return hl.supportsLanguage(mapped) ? mapped : undefined;
}

type HighlightTheme = Record<string, (text: string) => string>;

const SYNTAX_THEME_KEYS = [
	"syntaxComment",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxVariable",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxOperator",
	"syntaxPunctuation",
] as const;

function highlightThemeKey(theme?: FgTheme): string {
	if (!theme?.getFgAnsi) return "default";
	try {
		return SYNTAX_THEME_KEYS.map((key) => theme.getFgAnsi?.(key) ?? "").join("|");
	} catch {
		return "default";
	}
}

/** Map highlight.js scopes onto the active Pi theme's semantic syntax colors. */
function buildHighlightTheme(theme?: FgTheme): HighlightTheme | undefined {
	if (!theme) return undefined;
	const fg = (key: string) => (text: string) => theme.fg(key, text);
	return {
		keyword: fg("syntaxKeyword"),
		built_in: fg("syntaxType"),
		literal: fg("syntaxKeyword"),
		number: fg("syntaxNumber"),
		regexp: fg("syntaxString"),
		string: fg("syntaxString"),
		comment: fg("syntaxComment"),
		doctag: fg("syntaxComment"),
		meta: fg("syntaxComment"),
		function: fg("syntaxFunction"),
		title: fg("syntaxFunction"),
		class: fg("syntaxType"),
		type: fg("syntaxType"),
		tag: fg("syntaxPunctuation"),
		name: fg("syntaxKeyword"),
		attr: fg("syntaxVariable"),
		attribute: fg("syntaxVariable"),
		variable: fg("syntaxVariable"),
		params: fg("syntaxVariable"),
		operator: fg("syntaxOperator"),
		punctuation: fg("syntaxPunctuation"),
		addition: fg("toolDiffAdded"),
		deletion: fg("toolDiffRemoved"),
	};
}

export const _cache = new Map<string, string[]>();

function _touch(k: string, v: string[]): string[] {
	_cache.delete(k);
	_cache.set(k, v);
	while (_cache.size > CACHE_LIMIT) {
		const first = _cache.keys().next().value;
		if (first === undefined) break;
		_cache.delete(first);
	}
	return v;
}

// Async signature is preserved (renderers await hlBlock) even though
// cli-highlight is synchronous — keeps the call sites 1:1 with upstream.
export async function hlBlock(
	code: string,
	language: BundledLanguage | undefined,
	theme?: FgTheme,
): Promise<string[]> {
	if (!code) return [""];
	if (!language || code.length > MAX_HL_CHARS) return code.split("\n");
	// A single mega-line makes highlight.js backtrack catastrophically and freezes
	// the render thread — bail to plain before it reaches cli-highlight. Cheap
	// scan: split is already needed for the plain fallback and the cache miss path.
	const rawLines = code.split("\n");
	for (const line of rawLines) {
		if (line.length > MAX_HL_LINE_CHARS) return rawLines;
	}

	const hljsLang = toHljsLang(language);
	if (!hljsLang) return code.split("\n");

	const k = `${hljsLang}\0${highlightThemeKey(theme)}\0${code}`;
	const hit = _cache.get(k);
	if (hit) return _touch(k, hit);

	const hl = cliHighlight();
	if (!hl) return code.split("\n");

	try {
		const ansi = normalizeShikiContrast(
			hl.highlight(code, {
				language: hljsLang,
				ignoreIllegals: true,
				theme: buildHighlightTheme(theme),
			}),
		);
		const out = (ansi.endsWith("\n") ? ansi.slice(0, -1) : ansi).split("\n");
		return _touch(k, out);
	} catch {
		return code.split("\n");
	}
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

export function clearHighlightCache(): void {
	_cache.clear();
}
