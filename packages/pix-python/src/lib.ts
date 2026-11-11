/**
 * Pure helpers for python_run: repair model-written indentation, pick the
 * interpreter, then run the snippet (stdin script, so no shell quoting).
 */

import { isAbsolute, join, resolve } from "node:path";
import { runTool } from "@xynogen/pix-runtime/exec";
import { existsSync, statSync } from "@xynogen/pix-runtime/fs";
import {
	type PathAccess,
	type PathDecision,
	withPathAccess,
} from "@xynogen/pix-runtime/path-access";
import { expandHome, moduleFile, ownerDir, ownerRel } from "@xynogen/pix-runtime/paths";
import { currentPlatform } from "@xynogen/pix-runtime/platform";

const TAB = "    ";

/**
 * Make model-written Python runnable. The result is both what runs and what the
 * card shows, so its line numbers match the traceback:
 * - CRLF/CR → LF
 * - markdown fence lines (```python / ```) and leading/trailing blank lines dropped
 * - tabs and non-breaking spaces in leading indentation become spaces (tab = 4)
 * - the indent shared by every non-blank line is removed (like textwrap.dedent)
 */
export function normalizeCode(code: string): string {
	const lines = code
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.filter((line) => !/^\s*```[\w+-]*\s*$/.test(line))
		// ponytail: also rewrites leading tabs inside triple-quoted strings. Parse with `ast` if that bites.
		.map((line) =>
			line.replace(/^[\t \u00a0]+/, (ws) => ws.replace(/\t/g, TAB).replace(/\u00a0/g, " ")),
		)
		.map((line) => (line.trim() ? line : ""));
	const indents = lines.filter(Boolean).map((line) => line.length - line.trimStart().length);
	const common = indents.length ? Math.min(...indents) : 0;
	return lines
		.map((line) => line.slice(common))
		.join("\n")
		.replace(/^\n+|\s+$/g, "");
}

export interface PythonRun {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

/** Interpreter inside a venv/conda folder, or undefined if `dir` is not one. */
function venvPython(dir: string, win: boolean): string | undefined {
	const candidates = win
		? [join(dir, "Scripts", "python.exe"), join(dir, "python.exe")]
		: [join(dir, "bin", "python3"), join(dir, "bin", "python")];
	return candidates.find((p) => existsSync(p));
}

/** Managed venv that `packages` installs into: `<cwd>/.pi/pix-python/venv`. */
export const venvDir = (cwd: string) => ownerDir(cwd, "pix-python", "venv");
/** {@link venvDir} as shown to the model and user. */
export const VENV_REL = ownerRel("pix-python", "venv");

/**
 * Create the managed venv from `base` when missing, pip-install `packages`
 * into it, and return its interpreter. Entries are names/specifiers only:
 * a leading `-` would let the caller pass pip options (`--index-url`, `-r`).
 */
export async function ensureVenv(
	cwd: string,
	base: string,
	packages: readonly string[],
	signal?: AbortSignal,
	win = currentPlatform().os === "win32",
): Promise<string> {
	const bad = packages.find((p) => !p.trim() || p.trim().startsWith("-"));
	if (bad !== undefined)
		throw new Error(`invalid package "${bad}": names or specifiers only, no pip options`);
	const dir = venvDir(cwd);
	const check = (step: string, r: { code: number | null; stdout: string; stderr: string }) => {
		if (r.code === 0) return;
		const tail = (r.stderr || r.stdout).trim().split("\n").slice(-8).join("\n");
		throw new Error(`${step} failed (exit ${r.code}):\n${tail}`);
	};
	if (!venvPython(dir, win))
		check("venv creation", await runTool(base, ["-m", "venv", dir], { cwd, signal }));
	const py = venvPython(dir, win);
	if (!py) throw new Error(`no Python interpreter in ${dir} after venv creation`);
	if (packages.length)
		check(
			"pip install",
			await runTool(
				py,
				["-m", "pip", "install", "--disable-pip-version-check", ...packages.map((p) => p.trim())],
				{ cwd, signal },
			),
		);
	return py;
}

/**
 * Resolve the `python` parameter to what runTool should start:
 * - omitted → the managed venv ({@link venvDir}) when it exists, else `python3`
 *   (binary.json → PATH, the catalog lookup)
 * - a folder (`.venv`, `~/envs/x`, conda prefix) → its interpreter
 * - a file path (`.venv/bin/python`, `/usr/bin/python3.12`) → that file
 * - a bare name (`python3.12`, `pypy3`) → PATH lookup, unless it is a folder in cwd
 * Relative paths resolve against the session cwd. Throws with a clear message
 * when a given path does not exist, so the model can fix its call.
 */
export function resolvePython(
	python: string | undefined,
	cwd: string,
	win = currentPlatform().os === "win32",
): string {
	const raw = python?.trim();
	if (!raw) return venvPython(venvDir(cwd), win) ?? "python3";
	const isPath = isAbsolute(raw) || /[\\/]/.test(raw) || raw.startsWith("~") || raw.startsWith(".");
	const full = resolve(cwd, expandHome(raw));
	// A bare `venv` / `env` folder in cwd is a venv, not a PATH name.
	if (!isPath && !(existsSync(full) && statSync(full).isDirectory())) return raw;
	if (!existsSync(full)) throw new Error(`python path not found: ${full}`);
	if (!statSync(full).isDirectory()) return full;
	const inner = venvPython(full, win);
	if (!inner)
		throw new Error(
			`no Python interpreter in ${full} (expected bin/python3 or Scripts\\python.exe)`,
		);
	return inner;
}

export async function runPython(
	code: string,
	cwd: string,
	signal?: AbortSignal,
	/** Output of {@link resolvePython}. */
	interpreter = "python3",
	timeoutMs?: number,
	decide?: (access: PathAccess) => Promise<PathDecision>,
): Promise<PythonRun> {
	const run = async (args: string[]) => {
		const r = await runTool(interpreter, args, {
			cwd,
			input: `${code}\n`,
			signal,
			timeoutMs,
			// Windows consoles default to a legacy code page; keep output UTF-8 everywhere.
			env: { ...process.env, PYTHONIOENCODING: "utf-8" },
		});
		return { code: r.code, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut };
	};
	return decide
		? withPathAccess(
				decide,
				({ port, token }) => run([moduleFile(import.meta.url, "audit.py"), String(port), token]),
				signal,
			)
		: run(["-"]);
}
