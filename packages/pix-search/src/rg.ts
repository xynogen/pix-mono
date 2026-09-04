/**
 * Ripgrep-based file discovery.
 * - `rgFiles(query)` — filename matches via `rg --files` piped through fuzzy
 * - `rgContent(query)` — files containing query text via `rg -l`
 *
 * Both respect .gitignore, hidden-file exclusions, and abort signals.
 */

import { spawn } from "node:child_process";
import { basename } from "node:path";

export interface RgEntry {
	/** Relative path from basePath */
	path: string;
	/** Whether this matched by content (true) or filename (false) */
	contentMatch: boolean;
}

const TIMEOUT_MS = 3_000;

function spawnRg(args: string[], cwd: string, signal: AbortSignal): Promise<string[]> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve([]);
			return;
		}

		const child = spawn("rg", args, {
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
 * Search file contents for `query`, return matching file paths.
 * Uses fixed-string search (no regex) for speed + safety.
 */
export async function rgContent(
	query: string,
	cwd: string,
	signal: AbortSignal,
): Promise<string[]> {
	if (!query || query.length < 2) return [];
	return spawnRg(
		[
			"--files-with-matches",
			"--fixed-strings",
			"--ignore-case",
			"--hidden",
			"--glob",
			"!.git",
			"--max-count",
			"1", // stop after first match per file
			"--",
			query,
		],
		cwd,
		signal,
	);
}

/**
 * Combined file search: filename fuzzy + content grep.
 * Returns deduplicated entries, filename matches first.
 */
export async function rgSearch(
	query: string,
	cwd: string,
	signal: AbortSignal,
): Promise<RgEntry[]> {
	// Run both in parallel
	const [allFiles, contentFiles] = await Promise.all([
		rgFiles(cwd, signal),
		rgContent(query, cwd, signal),
	]);

	if (signal.aborted) return [];

	const seen = new Set<string>();
	const results: RgEntry[] = [];

	// Filename matches (all files, will be fuzzy-scored by caller)
	for (const path of allFiles) {
		if (seen.has(path)) continue;
		seen.add(path);
		results.push({ path, contentMatch: false });
	}

	// Content-only matches (files not already in filename results)
	for (const path of contentFiles) {
		if (seen.has(path)) continue;
		seen.add(path);
		results.push({ path, contentMatch: true });
	}

	return results;
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
