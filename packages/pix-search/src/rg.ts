/**
 * Ripgrep-based file discovery.
 * - `rgFiles()` — enumerate files via `rg --files`, scored by filename fuzzy
 *
 * Respects .gitignore, hidden-file exclusions, and abort signals.
 */

import { spawn } from "node:child_process";
import { basename } from "node:path";

// Bundled ripgrep: @vscode/ripgrep pulls a prebuilt rg per-platform on install
// and exposes its absolute path, so users no longer need rg on PATH. Fall back
// to a bare "rg" (PATH lookup) if the postinstall binary download was skipped
// (e.g. npm_config_ignore_scripts).
let RG_BIN = "rg";
try {
	RG_BIN = (require("@vscode/ripgrep") as { rgPath: string }).rgPath;
} catch {
	/* bundled binary unavailable — fall back to PATH `rg` */
}

const TIMEOUT_MS = 3_000;

function spawnRg(args: string[], cwd: string, signal: AbortSignal): Promise<string[]> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve([]);
			return;
		}

		const child = spawn(RG_BIN, args, {
			cwd,
			stdio: ["ignore", "pipe", "ignore"],
			// ponytail: no env filtering — inherits .gitignore respect from rg defaults
		});

		let stdout = "";
		let resolved = false;
		const timer = setTimeout(() => {
			if (!resolved) child.kill("SIGKILL");
		}, TIMEOUT_MS);

		const finish = (lines: string[]) => {
			if (resolved) return;
			resolved = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			resolve(lines);
		};

		const onAbort = () => {
			if (child.exitCode === null) child.kill("SIGKILL");
		};
		signal.addEventListener("abort", onAbort, { once: true });

		child.stdout.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.on("error", () => finish([]));
		child.on("close", () => {
			const lines = stdout
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((l) => l.replace(/\\/g, "/"));
			finish(lines);
		});
	});
}

/**
 * List all files via `rg --files`, return raw paths.
 * Fast — just enumerates, rg does .gitignore filtering.
 */
export async function rgFiles(cwd: string, signal: AbortSignal): Promise<string[]> {
	return spawnRg(["--files", "--hidden", "--glob", "!.git"], cwd, signal);
}

/**
 * Score a file path against a query for filename relevance.
 * Returns 0 for no match. Higher = better.
 */
export function scoreFilename(filePath: string, query: string): number {
	if (!query) return 1;

	const fileName = basename(filePath);
	const lowerFile = fileName.toLowerCase();
	const lowerPath = filePath.toLowerCase();
	const lowerQuery = query.toLowerCase();

	// Exact filename
	if (lowerFile === lowerQuery) return 100;
	// Filename starts with query
	if (lowerFile.startsWith(lowerQuery)) return 80;
	// Filename contains query
	if (lowerFile.includes(lowerQuery)) return 60;
	// Full path contains query
	if (lowerPath.includes(lowerQuery)) return 30;

	// Fuzzy: all query chars appear in order in filename
	let qi = 0;
	for (let i = 0; i < lowerFile.length && qi < lowerQuery.length; i++) {
		if (lowerFile[i] === lowerQuery[qi]) qi++;
	}
	if (qi === lowerQuery.length) return 20;

	// Fuzzy on full path
	qi = 0;
	for (let i = 0; i < lowerPath.length && qi < lowerQuery.length; i++) {
		if (lowerPath[i] === lowerQuery[qi]) qi++;
	}
	if (qi === lowerQuery.length) return 10;

	return 0;
}
