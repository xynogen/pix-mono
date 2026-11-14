import { join } from "node:path";
import type { GrepCursor } from "@ff-labs/fff-node";
import { cacheDir } from "@xynogen/pix-runtime/paths";

import type { FffBackedFinder, OptionalFffModule } from "./types.ts";

export interface FffState {
	module: OptionalFffModule | null;
	finder: FffBackedFinder | null;
	partialIndex: boolean;
	dbDir: string | null;
}

export const fffState: FffState = {
	module: null,
	finder: null,
	partialIndex: false,
	dbDir: null,
};

export const FFF_SCAN_TIMEOUT = 15_000;

/**
 * FFF state lives under the Pi cache dir, not the agent dir. Override with
 * PRETTY_FFF_DIR; otherwise `cacheDir()/fff` (~/.cache/pi/fff, or
 * $XDG_CACHE_HOME/pi/fff). Uses `os.homedir()` semantics — `HOME` is unset in
 * a Windows Pi process, which used to put the index inside the project.
 * The argument is ignored and kept for API compatibility.
 */
export function getPiPrettyFffDir(_agentDir?: string): string {
	const override = process.env.PRETTY_FFF_DIR?.trim();
	if (override) return override;
	return join(cacheDir(), "fff");
}

export async function fffEnsureFinder(cwd: string): Promise<FffBackedFinder | null> {
	if (fffState.finder && !fffState.finder.isDestroyed) return fffState.finder;
	if (!fffState.module || !fffState.dbDir) return null;

	const result = fffState.module.FileFinder.create({
		basePath: cwd,
		frecencyDbPath: join(fffState.dbDir, "frecency.mdb"),
		historyDbPath: join(fffState.dbDir, "history.mdb"),
		aiMode: true,
	});

	if (!result.ok) throw new Error(`FFF init failed: ${result.error}`);

	fffState.finder = result.value;
	const scan = await fffState.finder.waitForScan(FFF_SCAN_TIMEOUT);
	fffState.partialIndex = scan.ok && !scan.value;

	return fffState.finder;
}

export function fffDestroy(): void {
	if (fffState.finder && !fffState.finder.isDestroyed) {
		fffState.finder.destroy();
		fffState.finder = null;
	}
	fffState.partialIndex = false;
}

// ---------------------------------------------------------------------------
// FFF helpers (CursorStore)
// ---------------------------------------------------------------------------

/**
 * Store for FFF grep pagination cursors.
 * Evicts oldest entry when exceeding maxSize.
 */
export class CursorStore {
	private cursors = new Map<string, GrepCursor>();
	private counter = 0;
	private maxSize: number;

	constructor(maxSize = 200) {
		this.maxSize = maxSize;
	}

	store(cursor: GrepCursor): string {
		const id = `fff_c${++this.counter}`;
		this.cursors.set(id, cursor);
		if (this.cursors.size > this.maxSize) {
			const first = this.cursors.keys().next().value;
			if (first) this.cursors.delete(first);
		}
		return id;
	}

	get(id: string): GrepCursor | undefined {
		return this.cursors.get(id);
	}

	get size(): number {
		return this.cursors.size;
	}
}
