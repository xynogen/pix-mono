/**
 * paths.ts — canonical Pi/pix directories, pure and env-injectable.
 *
 * `agentDir()` mirrors Pi's `getAgentDir()` (PI_CODING_AGENT_DIR, `~`-expanded,
 * else `~/.pi/agent`) so code that runs outside a Pi process (CLIs, tests) and
 * code inside it agree. `binDir()` is the same folder Pi downloads fd/rg into.
 *
 * Home resolution never trusts `HOME` alone: it is unset in a Windows Pi process,
 * which silently turned `HOME ?? ""` paths into cwd-relative ones.
 */

import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * User home. For the live process this is exactly `os.homedir()` (what Pi's
 * `getAgentDir` uses). An injected env (tests) is read instead: USERPROFILE on
 * Windows, HOME elsewhere, falling back to `os.homedir()`.
 */
export function homeDir(
	env: NodeJS.ProcessEnv = process.env,
	os: NodeJS.Platform = process.platform,
): string {
	if (env === process.env) return homedir();
	const fromEnv = os === "win32" ? env.USERPROFILE : env.HOME;
	return fromEnv || homedir();
}

/** Expand a leading `~` / `~/` / `~\` against {@link homeDir}. */
export function expandHome(path: string, env: NodeJS.ProcessEnv = process.env): string {
	if (path === "~") return homeDir(env);
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(homeDir(env), path.slice(2));
	return path;
}

/** Pi agent dir: `PI_CODING_AGENT_DIR` (tilde-expanded) or `~/.pi/agent`. */
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.PI_CODING_AGENT_DIR;
	if (override) return expandHome(override, env);
	return join(homeDir(env), ".pi", "agent");
}

/** Pi's managed binary dir (`<agentDir>/bin`), shared with Pi's fd/rg downloads. */
export function binDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(agentDir(env), "bin");
}

const PROJECT_DIR_NAME = ".pi";

/**
 * Project dir: `<cwd>/.pi` (project level; the global `~/.pi/agent` is
 * {@link agentDir}). With no `cwd` it returns the relative `.pi`. Layout:
 * - user config and content at the root under fixed names: `settings.json`,
 *   `mcp.json`, `lsp.json`, `agents/`, `plans/` ({@link projectPath})
 * - generated state in one folder per owner, `.pi/<owner>/` ({@link ownerDir}).
 *   It can be rebuilt and deleted. pix-welcome offers to gitignore all of `.pi/`.
 */
export function projectDir(cwd = "."): string {
	return join(cwd, PROJECT_DIR_NAME);
}

/** `<cwd>/.pi/...segments` with the OS separator, for the filesystem. */
export function projectPath(cwd: string, ...segments: string[]): string {
	return join(projectDir(cwd), ...segments);
}

/**
 * `.pi/...segments` with `/` on every OS, for prompts and messages. Also a
 * valid cwd-relative path (`resolve` accepts `/` on Windows).
 */
export function projectRel(...segments: string[]): string {
	return [PROJECT_DIR_NAME, ...segments].join("/");
}

/** Generated state of one owner (package name, e.g. `pix-graph`): `<cwd>/.pi/<owner>/...rest`. */
export function ownerDir(cwd: string, owner: string, ...rest: string[]): string {
	return projectPath(cwd, owner, ...rest);
}

/** {@link ownerDir} for display: `.pi/<owner>/...rest` with `/`. */
export function ownerRel(owner: string, ...rest: string[]): string {
	return projectRel(owner, ...rest);
}

/**
 * OS temp dir, shared with every other program. Never delete it whole, only
 * your own entries in it. For the live process this is exactly `os.tmpdir()`.
 * An injected env (tests) is read instead: TEMP/TMP on Windows, TMPDIR
 * elsewhere, falling back to `os.tmpdir()`.
 */
export function tempDir(
	env: NodeJS.ProcessEnv = process.env,
	os: NodeJS.Platform = process.platform,
): string {
	if (env === process.env) return tmpdir();
	const fromEnv = os === "win32" ? env.TEMP || env.TMP : env.TMPDIR;
	return fromEnv || tmpdir();
}

/**
 * Absolute path to a file shipped next to a module: `moduleFile(import.meta.url, "..", "SOP.md")`.
 * Use it for package assets (SOP.md, skills/). It does not use `URL.pathname`, which gives
 * `/C:/...` on Windows. It does not use `require.resolve("<pkg>/package.json")`, which Node
 * rejects when `exports` omits it.
 */
export function moduleFile(moduleUrl: string, ...segments: string[]): string {
	return resolve(dirname(fileURLToPath(moduleUrl)), ...segments);
}

/** Pi cache root: `$XDG_CACHE_HOME/pi` or `~/.cache/pi`. */
export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
	const xdg = env.XDG_CACHE_HOME;
	return join(xdg || join(homeDir(env), ".cache"), "pi");
}
