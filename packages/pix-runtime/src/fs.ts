/**
 * fs.ts — the filesystem surface for feature packages: sync calls from
 * `node:fs`, async calls from `node:fs/promises` (the names do not overlap).
 * For writes where a partial file loses data, use `./atomic-write`.
 */

export {
	closeSync,
	constants,
	existsSync,
	type FSWatcher,
	globSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	watch,
	writeFileSync,
	writeSync,
} from "node:fs";
export {
	access,
	copyFile,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";

import { readdirSync } from "node:fs";

/** Top-level folders of `root` as `name/`: for home or `/`, which are too broad to walk. */
export function topLevelDirs(root: string, limit = Number.POSITIVE_INFINITY): string[] {
	return readdirSync(root, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.slice(0, limit)
		.map((e) => `${e.name}/`);
}
