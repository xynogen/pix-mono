/**
 * Pure file ranking — filename fuzzy score + git recency + depth penalty.
 * No TUI, no I/O: takes a file list and returns the best matches, so the
 * scoring is unit-testable independently of the picker UI.
 */

import { basename } from "node:path";
import type { RecencyMap } from "./recency.ts";
import { scoreFilename } from "./rg.ts";

const W_FILENAME = 1.0;
const W_RECENCY = 30;
const W_DEPTH = -0.5; // penalty per path depth level

export interface RankedFile {
	/** Path relative to the search root, with a trailing "/" for directories. */
	path: string;
	/** basename (with trailing "/" for dirs) for compact display. */
	label: string;
	score: number;
}

function depthOf(path: string): number {
	return path.split("/").length - 1;
}

/**
 * Rank `files` against `query`. Empty query returns all files ordered by
 * recency then depth (so the picker shows something useful before typing).
 * Files with no filename match are dropped once the query is non-empty.
 */
export function rankFiles(
	files: string[],
	query: string,
	recency: RecencyMap,
	limit = 20,
): RankedFile[] {
	const q = query.trim();
	const ranked: RankedFile[] = [];
	for (const path of files) {
		const fnScore = scoreFilename(path, q);
		if (q && fnScore === 0) continue;
		const isDir = path.endsWith("/");
		const clean = isDir ? path.slice(0, -1) : path;
		const score =
			fnScore * W_FILENAME + (recency.get(path) ?? 0) * W_RECENCY + depthOf(path) * W_DEPTH;
		ranked.push({ path, label: basename(clean) + (isDir ? "/" : ""), score });
	}
	ranked.sort((a, b) => b.score - a.score);
	return ranked.slice(0, limit);
}

/** Quote a path for insertion into the prompt only when it contains a space. */
export function atToken(path: string): string {
	return path.includes(" ") ? `@"${path}"` : `@${path}`;
}
