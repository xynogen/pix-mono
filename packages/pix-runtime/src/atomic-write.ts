/**
 * atomic-write.ts — write a file so readers never see a partial result.
 *
 * Writes to a unique sibling temp file, then renames over the target (rename is
 * atomic on the same filesystem). A crash mid-write leaves the old file intact.
 * Parent dirs are created.
 *
 * NOT a replacement for pix-runtime's ConfigStorage.writeAtomic, which adds a
 * cross-process lock. Use this for plain single-writer files (per-tool JSON
 * state, caches).
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Atomically write `contents` to `target`. Mode defaults to 0o600. */
export function writeFileAtomicSync(
	target: string,
	contents: string | Uint8Array,
	mode = 0o600,
): void {
	mkdirSync(dirname(target), { recursive: true });
	const tmp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
	try {
		writeFileSync(tmp, contents, { mode });
		renameSync(tmp, target);
	} catch (err) {
		try {
			rmSync(tmp, { force: true });
		} catch {
			/* best-effort cleanup */
		}
		throw err;
	}
}
