/**
 * Git recency cache — maps relative file paths to a recency score (0–1).
 * Uses `git log --name-only` to find recently touched files.
 * Cached per session, refreshed on demand.
 */

import { execFile } from "node:child_process";

const MAX_COMMITS = 200;
const DECAY = 0.97; // exponential decay per commit position

export type RecencyMap = Map<string, number>;

export function buildRecencyScores(gitOutput: string): RecencyMap {
	const scores: RecencyMap = new Map();
	// git log --name-only output: commit header, blank, files, blank, repeat
	const files = gitOutput
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && !l.startsWith("commit "));

	let position = 0;
	for (const file of files) {
		if (scores.has(file)) continue; // first occurrence = most recent
		scores.set(file, DECAY ** position);
		position++;
	}
	return scores;
}

export async function loadRecency(cwd: string, signal?: AbortSignal): Promise<RecencyMap> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve(new Map());
			return;
		}

		const child = execFile(
			"git",
			["log", "--name-only", "--pretty=format:", `-n${MAX_COMMITS}`, "--diff-filter=ACMR"],
			{ cwd, maxBuffer: 2 * 1024 * 1024, signal },
			(err, stdout) => {
				if (err || !stdout) {
					resolve(new Map());
					return;
				}
				resolve(buildRecencyScores(stdout));
			},
		);

		signal?.addEventListener(
			"abort",
			() => {
				child.kill("SIGKILL");
			},
			{ once: true },
		);
	});
}
