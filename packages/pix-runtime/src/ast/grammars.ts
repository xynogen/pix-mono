/**
 * grammars.ts — lazy, package-owned multi-language grammar loading.
 *
 * The napi addon bundles six grammars (see engine.ts). Every other ast-grep
 * language ships as its own `@ast-grep/lang-<x>` npm package. This module loads
 * one on demand:
 *
 *   1. If napi already parses it (the six), no grammar is needed.
 *   2. Else try to import `@ast-grep/lang-<x>` from the pix cache, then from
 *      the resolvable node_modules.
 *   3. If absent, report `needs-install` with the exact package name. The tool
 *      asks the user once, then this module installs it INTO the pix cache
 *      (never the agent, never a global write). A later call finds it cached.
 *
 * The cache lives at `<agentDir>/pix-astgrep/grammars`. We install with the
 * user's package manager into that private prefix, so a read-only global pix
 * install still works.
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runTool } from "../exec.ts";
import { agentDir } from "../paths.ts";
import { isBundled, loadEngine, parse, parseDynamic, type SgNode } from "./engine.ts";

const require = createRequire(import.meta.url);
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Canonical language alias → its `@ast-grep/lang-*` package name. */
const LANG_PACKAGE: Record<string, string> = {
	python: "@ast-grep/lang-python",
	go: "@ast-grep/lang-go",
	rust: "@ast-grep/lang-rust",
	java: "@ast-grep/lang-java",
	c: "@ast-grep/lang-c",
	cpp: "@ast-grep/lang-cpp",
	csharp: "@ast-grep/lang-csharp",
	ruby: "@ast-grep/lang-ruby",
	php: "@ast-grep/lang-php",
	swift: "@ast-grep/lang-swift",
	kotlin: "@ast-grep/lang-kotlin",
	scala: "@ast-grep/lang-scala",
	lua: "@ast-grep/lang-lua",
	elixir: "@ast-grep/lang-elixir",
	json: "@ast-grep/lang-json",
	yaml: "@ast-grep/lang-yaml",
	bash: "@ast-grep/lang-bash",
	haskell: "@ast-grep/lang-haskell",
};

/** Languages that need a `@ast-grep/lang-*` package (not the napi six). */
export function packageForLanguage(lang: string): string | undefined {
	return LANG_PACKAGE[lang];
}

/**
 * Cache root for installed grammars: `<agentDir>/pix-astgrep/grammars`. The path predates the
 * move into pix-runtime; it stays so grammars users already installed keep working.
 */
export function grammarCacheDir(): string {
	return join(agentDir(), "pix-astgrep", "grammars");
}

// ponytail: napi registers once per process. Load all cached grammars together;
// adding a language afterward needs an agent restart, not a silently ignored registration.
const stateKey = Symbol.for("pix-astgrep.grammars");
const globals = globalThis as typeof globalThis & {
	[stateKey]?: { registered: Set<string>; declined: Set<string>; registration?: Promise<void> };
};
globals[stateKey] ??= { registered: new Set(), declined: new Set() };
const state = globals[stateKey];
const { registered, declined } = state;

export type GrammarResult =
	| { kind: "ready" }
	| { kind: "napi" }
	| { kind: "needs-install"; pkg: string }
	| { kind: "declined"; pkg: string }
	| { kind: "unsupported" }
	| { kind: "error"; message: string };

/** Import a grammar module from the cache prefix, then this package. */
async function importGrammar(pkg: string): Promise<unknown | undefined> {
	const cached = join(grammarCacheDir(), "node_modules", pkg);
	const candidates = existsSync(cached) ? [cached, pkg] : [pkg];
	for (const spec of candidates) {
		let entry: string;
		try {
			entry = require.resolve(spec);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") continue;
			throw err;
		}
		const mod = (await import(pathToFileURL(entry).href)) as { default?: unknown };
		return mod.default ?? mod;
	}
	return undefined;
}

/**
 * Make a language usable. Returns `ready` when registered, `napi` when the
 * addon already covers it, `needs-install` with the package to install, or
 * `unsupported` for an unknown alias.
 */
export async function ensureLanguage(lang: string): Promise<GrammarResult> {
	const engine = await loadEngine();
	if (!engine) return { kind: "error", message: "ast-grep engine unavailable" };

	// The six bundled grammars never need a package.
	if (isBundled(lang)) {
		return { kind: "napi" };
	}
	const pkg = packageForLanguage(lang);
	if (!pkg) return { kind: "unsupported" };
	if (registered.has(lang)) return { kind: "ready" };

	try {
		const grammar = await importGrammar(pkg);
		if (!grammar) return { kind: "needs-install", pkg };
		state.registration ??= (async () => {
			const grammars: Record<string, unknown> = {};
			for (const [alias, name] of Object.entries(LANG_PACKAGE)) {
				const loaded = await importGrammar(name);
				if (loaded) grammars[alias] = loaded;
			}
			engine.registerDynamicLanguage(grammars);
			for (const alias of Object.keys(grammars)) registered.add(alias);
		})();
		await state.registration;
		return registered.has(lang)
			? { kind: "ready" }
			: {
					kind: "error",
					message: `${pkg} is installed, but napi's language registry is already initialized. Restart the agent to load newly installed grammars.`,
				};
	} catch (err) {
		return { kind: "error", message: errorText(err) };
	}
}

/**
 * Install a `@ast-grep/lang-*` package into the pix cache prefix. This runs a
 * network install — the caller must get user consent first. It never touches a
 * global path or this package's own node_modules.
 */
export async function installGrammar(pkg: string): Promise<{ ok: boolean; message?: string }> {
	const dir = grammarCacheDir();
	try {
		await mkdir(dir, { recursive: true });
		// A minimal package.json so npm installs into this prefix cleanly.
		const pkgJson = join(dir, "package.json");
		if (!existsSync(pkgJson)) {
			const { writeFile } = await import("node:fs/promises");
			await writeFile(pkgJson, JSON.stringify({ name: "pix-astgrep-grammars", private: true }));
		}
		const result = await runTool("npm", ["install", "--save", "--prefix", dir, pkg], {
			cwd: dir,
			timeoutMs: 120_000,
		});
		if (result.code !== 0) {
			return {
				ok: false,
				message: result.timedOut
					? "grammar installation timed out"
					: result.stderr || `npm exited ${result.code}`,
			};
		}
		return { ok: true };
	} catch (err) {
		return { ok: false, message: errorText(err) };
	}
}

export type ParseOutcome = { kind: "ok"; root: SgNode } | GrammarResult;

/** A one-time consent callback: return true to install `pkg`. */
export type ConsentFn = (pkg: string) => Promise<boolean>;

/**
 * Parse one file's source for any language alias, installing a missing grammar
 * with consent. The bundled six always parse. A non-bundled language is loaded
 * from the pix cache. When absent, `consent(pkg)` decides whether to install it
 * INTO the cache (once per language). A declined language is remembered so the
 * caller is not asked again this session.
 */
export async function parseWithGrammar(
	lang: string,
	source: string,
	consent?: ConsentFn,
): Promise<ParseOutcome> {
	const engine = await loadEngine();
	if (!engine) return { kind: "error", message: "ast-grep engine unavailable" };

	try {
		if (isBundled(lang)) return { kind: "ok", root: parse(engine, lang, source) };
		if (declined.has(lang)) {
			return { kind: "declined", pkg: packageForLanguage(lang) ?? lang };
		}

		let ready = await ensureLanguage(lang);
		if (ready.kind === "needs-install") {
			if (!consent) return ready;
			if (!(await consent(ready.pkg))) {
				declined.add(lang);
				return { kind: "declined", pkg: ready.pkg };
			}
			const installed = await installGrammar(ready.pkg);
			if (!installed.ok) {
				return { kind: "error", message: installed.message ?? `failed to install ${ready.pkg}` };
			}
			ready = await ensureLanguage(lang);
		}
		if (ready.kind !== "ready") return ready;
		return { kind: "ok", root: parseDynamic(engine, lang, source) };
	} catch (err) {
		return { kind: "error", message: errorText(err) };
	}
}
