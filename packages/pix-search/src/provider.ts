/**
 * Autocomplete provider wrapper — intercepts @ suggestions and re-ranks
 * files by filename fuzzy score and git recency.
 *
 * Non-@ completions (slash commands, path completions) pass through to the
 * built-in provider unchanged.
 */

import { basename } from "node:path";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import type { RecencyMap } from "./recency.ts";
import { rgFiles, scoreFilename } from "./rg.ts";

const MAX_SUGGESTIONS = 20;

/** Weight factors for the combined score */
const W_FILENAME = 1.0;
const W_RECENCY = 30;
const W_DEPTH = -0.5; // penalty per path depth level

interface ScoredEntry {
	path: string;
	filenameScore: number;
	recencyScore: number;
	depth: number;
}

function depthOf(path: string): number {
	return path.split("/").length - 1;
}

function combinedScore(entry: ScoredEntry): number {
	return entry.filenameScore * W_FILENAME + entry.recencyScore * W_RECENCY + entry.depth * W_DEPTH;
}

/**
 * Find the active `@`-token in the text before the cursor, allowing spaces in
 * the query. A token starts at an `@` that is at line start or preceded by
 * whitespace and runs to the cursor. Returns the raw prefix (`@…`, including
 * any spaces/open-quote) plus the extracted query and quoted flag.
 *
 * The host editor stops re-triggering autocomplete once a space is typed
 * (its trigger regex is `/(?:^|\s)@[^\s]*$/`), but it keeps calling the
 * provider on every keystroke while the dropdown stays open — so detecting the
 * token ourselves (spaces included) is what makes unquoted space-search work.
 * ponytail: everything from `@` to the cursor is treated as the query, so a
 * space cannot end the token inline — pick a result (inserts a quoted path +
 * space) or press Esc to leave `@`-mode. Ceiling: no "@file then prose on the
 * same run of text"; upgrade path is a dedicated overlay picker.
 */
function findAtToken(before: string): { prefix: string; query: string; quoted: boolean } | null {
	let start = -1;
	for (let i = 0; i < before.length; i++) {
		if (before[i] === "@" && (i === 0 || /\s/.test(before[i - 1] ?? ""))) start = i;
	}
	if (start === -1) return null;
	const prefix = before.slice(start);
	let query = prefix.slice(1);
	let quoted = false;
	if (query.startsWith('"')) {
		quoted = true;
		query = query.slice(1);
		if (query.endsWith('"')) query = query.slice(0, -1);
	}
	return { prefix, query, quoted };
}

function buildValue(path: string, isDir: boolean, quoted: boolean): string {
	const displayPath = isDir ? `${path}/` : path;
	const needsQuotes = quoted || path.includes(" ");
	if (!needsQuotes) return `@${displayPath}`;
	return `@"${displayPath}"`;
}

export function createSearchProvider(
	inner: AutocompleteProvider,
	cwd: string,
	getRecency: () => RecencyMap,
): AutocompleteProvider {
	return {
		triggerCharacters: inner.triggerCharacters,

		async getSuggestions(
			lines,
			cursorLine,
			cursorCol,
			options,
		): Promise<AutocompleteSuggestions | null> {
			// Detect the @-token ourselves (spaces allowed) rather than relying on
			// the host's inner provider, whose @-detection stops at a space.
			const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
			const token = findAtToken(before);
			if (!token) {
				// Not in @-mode — defer entirely to the built-in provider.
				return inner.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const { prefix, query, quoted: isQuoted } = token;
			const { signal } = options;

			if (signal.aborted) return null;

			const allFiles = await rgFiles(cwd, signal);

			if (signal.aborted) return null;

			const recency = getRecency();

			// Score every file by filename fuzzy match only.
			const scored: ScoredEntry[] = [];
			for (const path of allFiles) {
				const fnScore = scoreFilename(path, query);
				if (fnScore === 0) continue;
				scored.push({
					path,
					filenameScore: fnScore,
					recencyScore: recency.get(path) ?? 0,
					depth: depthOf(path),
				});
			}

			// Sort by combined score descending
			scored.sort((a, b) => combinedScore(b) - combinedScore(a));

			const items: AutocompleteItem[] = scored.slice(0, MAX_SUGGESTIONS).map((entry) => {
				const isDir = entry.path.endsWith("/");
				const cleanPath = isDir ? entry.path.slice(0, -1) : entry.path;
				const label = basename(cleanPath) + (isDir ? "/" : "");
				return {
					value: buildValue(cleanPath, isDir, isQuoted),
					label,
					description: entry.path,
				};
			});

			// Keep the dropdown open with a placeholder even on zero matches, so a
			// typed space doesn't let the host tear down @-mode (which our
			// space-in-query support depends on). Esc still exits @-mode.
			if (items.length === 0) {
				return { items: [{ value: prefix, label: "no matches", description: query }], prefix };
			}

			return { items, prefix };
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return inner.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return inner.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}
