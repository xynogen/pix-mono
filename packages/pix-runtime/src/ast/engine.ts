/**
 * engine.ts — the lazy @ast-grep/napi loader and language map.
 *
 * The native addon loads on first tool call, never at extension registration.
 * The addon bundles six grammars: ts, tsx, js, jsx, css, html. We map file
 * extensions to language aliases. Non-bundled languages use grammars.ts, which
 * loads cached grammar packages or installs them only after user consent.
 *
 * Loader adapted from pi-lens `clients/deps/ast-grep-napi.ts` (MIT). See
 * packages/pix-diagnostics/LICENSE.pi-lens.
 *
 * `@ast-grep/napi` is an optional peer: pix-runtime never forces the native addon on
 * every install. Packages that parse (pix-astgrep, pix-graph) depend on it; without it
 * `loadEngine()` returns undefined and callers degrade.
 * ponytail: resolution assumes npm hoists napi next to pix-runtime (the flat Pi install).
 */

import { createRequire } from "node:module";
import { extname } from "node:path";
import { pathToFileURL } from "node:url";

// The typed shape of the addon accessor we use (parse → root → findAll).
export interface SgEdit {
	startPos: number;
	endPos: number;
	insertedText: string;
}
export interface SgNode {
	text(): string;
	kind(): string;
	range(): { start: SgPos; end: SgPos };
	findAll(matcher: string | { rule: Record<string, unknown> }): SgNode[];
	children(): SgNode[];
	isNamed(): boolean;
	/** Child stored under a tree-sitter field name (`name`, `body`, `function`, …). */
	field(name: string): SgNode | null;
	replace(text: string): SgEdit;
	commitEdits(edits: SgEdit[]): string;
	getMatch(name: string): SgNode | null;
	getMultipleMatches(name: string): SgNode[];
}
interface SgPos {
	line: number;
	column: number;
	index: number;
}
interface SgRoot {
	root(): SgNode;
}
interface LangApi {
	parse(source: string): SgRoot;
}
interface AstGrepNapi {
	ts: LangApi;
	tsx: LangApi;
	js: LangApi;
	jsx: LangApi;
	css: LangApi;
	html: LangApi;
	/** Top-level parse for a dynamically registered language, keyed by alias. */
	parse(lang: string, source: string): SgRoot;
	registerDynamicLanguage(langs: Record<string, unknown>): void;
}

const _require = createRequire(import.meta.url);
let cached: AstGrepNapi | undefined;
let loadPromise: Promise<AstGrepNapi | undefined> | undefined;

/** Load the native addon once. Returns `undefined` when it cannot load. */
export async function loadEngine(): Promise<AstGrepNapi | undefined> {
	if (cached) return cached;
	if (loadPromise) return loadPromise;
	loadPromise = (async () => {
		try {
			const entry = _require.resolve("@ast-grep/napi");
			// SAFETY: the addon has no bundled ESM types; the accessors we use
			// (ts/tsx/js/jsx/css/html .parse) are verified at runtime by tests.
			const mod = (await import(pathToFileURL(entry).href)) as unknown as AstGrepNapi;
			cached = mod;
			return mod;
		} catch {
			return undefined;
		} finally {
			loadPromise = undefined;
		}
	})();
	return loadPromise;
}

/** The six grammars the napi addon parses in-process without any package. */
export const LANGUAGES = ["typescript", "tsx", "javascript", "jsx", "css", "html"] as const;
export type Language = (typeof LANGUAGES)[number];
const BUNDLED = new Set<string>(LANGUAGES);

/** True when napi parses this alias in-process (no `@ast-grep/lang-*` needed). */
export function isBundled(lang: string): lang is Language {
	return BUNDLED.has(lang);
}

/**
 * Supported ast-grep language aliases. The six bundled ones parse in-process;
 * the rest have published `@ast-grep/lang-*` packages (see grammars.ts).
 * This intentionally excludes languages without an installable grammar.
 */
export const ALL_LANGUAGES = [
	"typescript",
	"tsx",
	"javascript",
	"jsx",
	"css",
	"html",
	"python",
	"go",
	"rust",
	"java",
	"c",
	"cpp",
	"csharp",
	"ruby",
	"php",
	"swift",
	"kotlin",
	"scala",
	"lua",
	"elixir",
	"json",
	"yaml",
	"bash",
	"haskell",
] as const;
export type AnyLanguage = (typeof ALL_LANGUAGES)[number];

// File extension → language alias, from the ast-grep language table.
const EXT_TO_LANG: Record<string, AnyLanguage> = {
	".ts": "typescript",
	".mts": "typescript",
	".cts": "typescript",
	".tsx": "tsx",
	".js": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".jsx": "jsx",
	".css": "css",
	".html": "html",
	".htm": "html",
	".xhtml": "html",
	".py": "python",
	".pyi": "python",
	".go": "go",
	".rs": "rust",
	".java": "java",
	".c": "c",
	".h": "c",
	".cc": "cpp",
	".cpp": "cpp",
	".cxx": "cpp",
	".hpp": "cpp",
	".hh": "cpp",
	".cu": "cpp",
	".cs": "csharp",
	".rb": "ruby",
	".gemspec": "ruby",
	".php": "php",
	".swift": "swift",
	".kt": "kotlin",
	".kts": "kotlin",
	".scala": "scala",
	".sc": "scala",
	".sbt": "scala",
	".lua": "lua",
	".ex": "elixir",
	".exs": "elixir",
	".json": "json",
	".yml": "yaml",
	".yaml": "yaml",
	".sh": "bash",
	".bash": "bash",
	".zsh": "bash",
	".ksh": "bash",
	".hs": "haskell",
};

/** Map a file path to any ast-grep language alias, or `undefined`. */
export function languageForFile(path: string): AnyLanguage | undefined {
	return EXT_TO_LANG[extname(path).toLowerCase()];
}

/** Get the addon accessor for a language, or `undefined` when unsupported. */
export function accessorFor(engine: AstGrepNapi, lang: Language): LangApi {
	switch (lang) {
		case "typescript":
			return engine.ts;
		case "tsx":
			return engine.tsx;
		case "javascript":
			return engine.js;
		case "jsx":
			return engine.jsx;
		case "css":
			return engine.css;
		case "html":
			return engine.html;
		default:
			throw new Error(`unsupported language: ${lang as string}`);
	}
}

/** Parse source into a root node for one bundled language. */
export function parse(engine: AstGrepNapi, lang: Language, source: string): SgNode {
	return accessorFor(engine, lang).parse(source).root();
}

/**
 * Parse source for any language alias, including a dynamically registered one.
 * The caller must have run `ensureLanguage(lang)` first for non-bundled ones.
 */
export function parseDynamic(engine: AstGrepNapi, lang: string, source: string): SgNode {
	return engine.parse(lang, source).root();
}
