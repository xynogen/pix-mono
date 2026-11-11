/**
 * patch-builtin.ts — route Pi's built-in /model slash command to pix at load time.
 *
 * Built-in commands can't be removed via the extension API, so we edit Pi's
 * compiled source directly: drop `/model` from BUILTIN_SLASH_COMMANDS
 * (autocomplete) and disable the editor submit shortcut that opens Pi's own
 * picker before extension commands run. Done on every load: idempotent and
 * self-healing across Pi upgrades. An unknown host format is left unchanged,
 * so the failure mode is Pi's own picker, never a crash.
 *
 * Pi's build layout has moved over time. Two forms are in the wild:
 *   - legacy:  <pkg>/dist/core/slash-commands.js  (readable, one entry/line)
 *   - bundled: <pkg>/dist/bundle/chunks/chunk-*.js (minified, hash-named)
 * The bundled chunk is what the runtime actually executes; the legacy
 * dist/core/ file may still exist as dead output. We therefore prefer the
 * chunk that really contains the `BUILTIN_SLASH_COMMANDS=[...]` assignment and
 * only fall back to dist/core/ for older hosts that lack a bundle dir.
 *
 * Package-root resolution (in order):
 *   1. The running CLI script (`process.argv[1]`) → split at /dist/.
 *   2. Pi managed install: `<PI_MANAGED_INSTALL_ROOT | agentDir/install>/
 *      releases/<current-version>/node_modules/@earendil-works/pi-coding-agent`.
 *   3. `pi` binary via PATH → realpath → split at /dist/ to get the pkg root.
 *   4. Well-known global install locations (bun, npm).
 *   5. require resolution from the extension's own node_modules.
 */

import { join, sep } from "node:path";
import {
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "@xynogen/pix-runtime/fs";
import { agentDir, homeDir, requireFrom } from "@xynogen/pix-runtime/paths";
import { findExecutableSync } from "@xynogen/pix-runtime/which";

const PI_PACKAGE = ["@earendil-works", "pi-coding-agent"] as const;

/** Package root before `/dist/` in a path, if any. */
function rootBeforeDist(path: string | undefined): string | undefined {
	if (!path) return undefined;
	const idx = path.indexOf(`${sep}dist${sep}`);
	return idx >= 0 ? path.slice(0, idx) : undefined;
}

/**
 * Package root of Pi's managed install (`releases-v1` layout), or undefined
 * when the install dir or its `current-version` file is absent.
 */
export function managedInstallRoot(
	installRoot: string = process.env.PI_MANAGED_INSTALL_ROOT || join(agentDir(), "install"),
): string | undefined {
	try {
		const version = readFileSync(join(installRoot, "current-version"), "utf8").trim();
		if (!/^[0-9A-Za-z._+-]+$/.test(version) || version === "." || version === "..")
			return undefined;
		return join(installRoot, "releases", version, "node_modules", ...PI_PACKAGE);
	} catch {
		return undefined;
	}
}

/** Locate `pi` on PATH, returning its real (symlink-resolved) path. */
function resolvePiBinary(): string | undefined {
	const found = findExecutableSync("pi");
	if (!found) return undefined;
	try {
		return realpathSync(found);
	} catch {
		return found;
	}
}

// The assignment appears once per build. `\s*=\s*\[` avoids the `.map(...)`
// references and tolerates both `= [` (pretty) and `=[` (minified) spacing.
const BUILTIN_COMMANDS_ARRAY = /BUILTIN_SLASH_COMMANDS\s*=\s*\[/;
// Match one flat (non-nested) command object whose stable `name` is exactly
// "model", plus an optional trailing comma. No line anchors, so it works for
// both minified inline entries and pretty multi-line ones. The `["']model["']`
// requires a closing quote right after `model`, so `models`/`scoped-models`
// never match.
const BUILTIN_MODEL_COMMAND = /\{(?=[^{}]*\bname\s*:\s*["']model["'])[^{}]*\},?/g;
// The interactive submit handler opens Pi's picker for `/model` before extension
// commands run: `text === "/model" || text.startsWith("/model ")`. The variable name
// is a backreference so a renamed minified binding still matches.
const BUILTIN_MODEL_SUBMIT =
	/\b([\w$]+)\s*===\s*(["'])\/model\2\s*\|\|\s*\1\.startsWith\(\s*(["'])\/model \3\s*\)/g;

/** Infer pi-coding-agent package roots, most-specific first. */
function packageRoots(): string[] {
	const roots: string[] = [];
	const pushRoot = (r: string | undefined) => {
		if (r && !roots.includes(r)) roots.push(r);
	};

	// 1. The CLI script this process is running (most specific).
	try {
		pushRoot(rootBeforeDist(process.argv[1] ? realpathSync(process.argv[1]) : undefined));
	} catch {
		pushRoot(rootBeforeDist(process.argv[1]));
	}

	// 2. Pi managed install (pi on PATH is a launcher shim there).
	pushRoot(managedInstallRoot());

	// 3. Resolve via the `pi` binary on PATH → realpath → strip at /dist/.
	pushRoot(rootBeforeDist(resolvePiBinary()));

	// 4. Well-known global install locations.
	const home = homeDir();
	for (const root of [
		join(home, ".bun", "install", "global", "node_modules"),
		join(home, ".npm-global", "lib", "node_modules"),
		"/usr/local/lib/node_modules",
		"/usr/lib/node_modules",
	]) {
		pushRoot(join(root, ...PI_PACKAGE));
	}

	// 5. Fallback: require resolution from this file (co-installed extension).
	try {
		const require = requireFrom(import.meta.url);
		pushRoot(rootBeforeDist(require.resolve("@earendil-works/pi-coding-agent")));
	} catch {
		// local resolution failed — skip
	}

	return roots;
}

/** Candidate source files for a package root — live bundle chunks first. */
function candidateFiles(root: string): string[] {
	const files: string[] = [];
	const chunkDir = join(root, "dist", "bundle", "chunks");
	try {
		for (const name of readdirSync(chunkDir)) {
			if (name.endsWith(".js")) files.push(join(chunkDir, name));
		}
	} catch {
		// no bundle dir on this host — legacy layout below
	}
	// Legacy readable output, kept as a fallback for older Pi builds.
	files.push(
		join(root, "dist", "core", "slash-commands.js"),
		join(root, "dist", "modes", "interactive", "interactive-mode.js"),
	);
	return files;
}

/**
 * Source files of the first Pi install that declares BUILTIN_SLASH_COMMANDS.
 * Chunk filenames are content hashes, so we confirm by contents, not by name.
 * Every file of that install is returned: in the legacy layout the submit
 * handler lives outside slash-commands.js.
 */
function findPiSourceFiles(): string[] {
	for (const root of packageRoots()) {
		const files = candidateFiles(root).filter((p) => existsSync(p));
		const declares = files.some((p) => {
			try {
				return BUILTIN_COMMANDS_ARRAY.test(readFileSync(p, "utf8"));
			} catch {
				return false; // unreadable — skip
			}
		});
		if (declares) return files;
	}
	return [];
}

/**
 * Route Pi's built-in /model to the pix picker in Pi's compiled source.
 * Idempotent: skips files that are missing, unreadable or already patched.
 */
export function patchOutBuiltinModelCommand(): void {
	for (const file of findPiSourceFiles()) {
		let source: string;
		try {
			source = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		const patched = stripBuiltinModelCommand(source);
		if (patched === source) continue; // already patched, or host format is unknown
		try {
			writeFileSync(file, patched, "utf8");
		} catch {
			// Read-only install — leave /model in place rather than crash.
		}
	}
}

/**
 * Neutralise Pi's built-in `/model` in compiled source: remove its
 * BUILTIN_SLASH_COMMANDS entry and turn its submit shortcut into `false`.
 *
 * The command objects are static, flat literals. Matching the entry's `name`
 * tolerates added properties and line wrapping without touching `/models`.
 */
export function stripBuiltinModelCommand(source: string): string {
	return stripArrayEntry(source).replace(BUILTIN_MODEL_SUBMIT, "false");
}

function stripArrayEntry(source: string): string {
	const array = BUILTIN_COMMANDS_ARRAY.exec(source);
	if (!array || array.index === undefined) return source;

	const open = array.index + array[0].lastIndexOf("[");
	const close = source.indexOf("];", open);
	if (close < 0) return source;

	const entries = source.slice(open + 1, close);
	const patchedEntries = entries.replace(BUILTIN_MODEL_COMMAND, "");
	if (patchedEntries === entries) return source;

	return `${source.slice(0, open + 1)}${patchedEntries}${source.slice(close)}`;
}

// Export for tests
export { findPiSourceFiles };
