/**
 * Autocomplete provider wrapper — intercepts @ suggestions and re-ranks
 * using rg file discovery, fuzzy scoring, and git recency.
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
import { rgContent, rgFiles, scoreFilename } from "./rg.ts";

const MAX_SUGGESTIONS = 20;
/** Minimum query length before we also search file contents */
const CONTENT_SEARCH_MIN = 2;

/** Weight factors for the combined score */
const W_FILENAME = 1.0;
const W_RECENCY = 30;
const W_CONTENT = 25;
const W_DEPTH = -0.5; // penalty per path depth level

interface ScoredEntry {
	path: string;
	filenameScore: number;
	recencyScore: number;
	contentMatch: boolean;
	depth: number;
}

function depthOf(path: string): number {
	return path.split("/").length - 1;
}

function combinedScore(entry: ScoredEntry): number {
	return (
		entry.filenameScore * W_FILENAME +
		entry.recencyScore * W_RECENCY +
		(entry.contentMatch ? W_CONTENT : 0) +
		entry.depth * W_DEPTH
	);
}

function isAtPrefix(prefix: string): boolean {
	return prefix.startsWith("@") || prefix.startsWith('@"');
}

function extractRawQuery(prefix: string): string {
	let raw = prefix;
	if (raw.startsWith('@"')) raw = raw.slice(2);
	else if (raw.startsWith("@")) raw = raw.slice(1);
	if (raw.endsWith('"')) raw = raw.slice(0, -1);
	return raw;
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
			// Let inner figure out if this is an @ prefix
			const result = await inner.getSuggestions(lines, cursorLine, cursorCol, options);

			// Not an @ prefix, or inner returned nothing — pass through
			if (!result || !isAtPrefix(result.prefix)) return result;

			const query = extractRawQuery(result.prefix);
			const isQuoted = result.prefix.includes('"');
			const { signal } = options;

			if (signal.aborted) return result;

			// Run rg in parallel: file listing + content search
			const [allFiles, contentFiles] = await Promise.all([
				rgFiles(cwd, signal),
				query.length >= CONTENT_SEARCH_MIN ? rgContent(query, cwd, signal) : Promise.resolve([]),
			]);

			if (signal.aborted) return result;

			const contentSet = new Set(contentFiles);
			const recency = getRecency();

			// Score every file
			const scored: ScoredEntry[] = [];
			for (const path of allFiles) {
				const fnScore = scoreFilename(path, query);
				const isContent = contentSet.has(path);
				// Skip if neither filename nor content match
				if (fnScore === 0 && !isContent) continue;

				scored.push({
					path,
					filenameScore: fnScore,
					recencyScore: recency.get(path) ?? 0,
					contentMatch: isContent,
					depth: depthOf(path),
				});
			}

			// Add content-only matches not in allFiles
			for (const path of contentFiles) {
				if (scored.some((e) => e.path === path)) continue;
				scored.push({
					path,
					filenameScore: 0,
					recencyScore: recency.get(path) ?? 0,
					contentMatch: true,
					depth: depthOf(path),
				});
			}

			// Sort by combined score descending
			scored.sort((a, b) => combinedScore(b) - combinedScore(a));

			const items: AutocompleteItem[] = scored.slice(0, MAX_SUGGESTIONS).map((entry) => {
				const isDir = entry.path.endsWith("/");
				const cleanPath = isDir ? entry.path.slice(0, -1) : entry.path;
				const label = basename(cleanPath) + (isDir ? "/" : "");
				const desc =
					entry.contentMatch && entry.filenameScore === 0
						? `${entry.path} (content match)`
						: entry.path;
				return {
					value: buildValue(cleanPath, isDir, isQuoted),
					label,
					description: desc,
				};
			});

			if (items.length === 0) return result; // fall back to built-in

			return { items, prefix: result.prefix };
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return inner.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return inner.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}
