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

/**
 * Expand a flat file list into files + the directories that contain them, so
 * the picker can offer folders as selectable targets. Directories keep a
 * trailing "/" (rankFiles already treats that as a dir label). Order is
 * files-as-given with derived dirs appended; rankFiles re-sorts by score.
 */
export function withDirectories(files: string[]): string[] {
	const dirs = new Set<string>();
	for (const path of files) {
		const parts = path.split("/");
		for (let i = 1; i < parts.length; i++) {
			dirs.add(`${parts.slice(0, i).join("/")}/`);
		}
	}
	// Drop any dir that already appears verbatim in files (rare) to avoid dupes.
	const seen = new Set(files);
	return [...files, ...[...dirs].filter((d) => !seen.has(d))];
}
