/**
 * migrations.ts — ordered, idempotent, pure migrations over a RawDocument plus
 * the legacy `optimizer.json` sidecar importer.
 *
 * ponytail: the DESIGN.md staged optimizer mirror (keep optimizer.json as a
 * read/write mirror for a full release train) is simplified here to a one-time
 * import + archive. That is safe for a greenfield 0.1.0 where no published
 * consumer delegates to runtime yet. Upgrade path: reinstate the mirror window
 * in section 8.2 before any consumer ships runtime-backed optimizer writes.
 */

import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FORMAT_VERSION, isObj, type ParseContext, type RawDocument } from "./schema.ts";

const LEGACY_PRETTY_COLOR_KEYS = ["theme", "syntaxTheme", "diffColors"] as const;
const LEGACY_DIFF_COLOR_KEYS = [
	"bgAdd",
	"bgDel",
	"bgAddHighlight",
	"bgDelHighlight",
	"bgGutterAdd",
	"bgGutterDel",
	"fgAdd",
	"fgDel",
] as const;

const OPTIMIZER_KEYS = ["caveman", "rtk", "ponytail"] as const;

export interface MigrationResult {
	document: RawDocument;
	changed: boolean;
}

/** Detected source format of a raw document. */
export function detectVersion(doc: RawDocument): number | "unversioned" {
	const v = doc.$version;
	return typeof v === "number" && Number.isFinite(v) ? v : "unversioned";
}

/**
 * Migrate a raw document up to the current format version. Pure: returns a new
 * document and whether anything changed. Unknown keys are preserved.
 */
export function migrate(input: RawDocument, ctx: ParseContext): MigrationResult {
	const version = detectVersion(input);

	if (typeof version === "number" && version > CONFIG_FORMAT_VERSION) {
		// Future version: caller enters read-only mode. Do not mutate.
		ctx.diagnostic({
			code: "UNSUPPORTED_CONFIG_VERSION",
			severity: "error",
			message: `config $version ${version} is newer than supported ${CONFIG_FORMAT_VERSION}`,
		});
		return { document: input, changed: false };
	}

	const doc: RawDocument = structuredClone(input);
	let changed = false;

	// Remove legacy color keys — active themes own all colors now.
	if (isObj(doc.pretty)) {
		const pretty = { ...doc.pretty };
		for (const key of LEGACY_PRETTY_COLOR_KEYS) {
			if (key in pretty) {
				delete pretty[key];
				changed = true;
			}
		}
		if (isObj(pretty.diff)) {
			const diff = { ...pretty.diff };
			for (const key of LEGACY_DIFF_COLOR_KEYS) {
				if (key in diff) {
					delete diff[key];
					changed = true;
				}
			}
			pretty.diff = diff;
		}
		doc.pretty = pretty;
	}

	// TOON is now an on-demand pix-skills capability, not optimizer state.
	if (isObj(doc.optimizer) && "toon" in doc.optimizer) {
		doc.optimizer = Object.fromEntries(
			Object.entries(doc.optimizer).filter(([key]) => key !== "toon"),
		);
		changed = true;
	}

	if (doc.$version !== CONFIG_FORMAT_VERSION) {
		doc.$version = CONFIG_FORMAT_VERSION;
		changed = true;
	}

	return { document: doc, changed };
}

/**
 * Import `optimizer.json` sidecar into `doc.optimizer` exactly once. Canonical
 * `pix.json.optimizer.<key>` wins conflicts. Returns whether the document
 * changed and whether the sidecar should be archived after a successful write.
 */
export function importOptimizerSidecar(
	doc: RawDocument,
	agentDir: string,
	ctx: ParseContext,
): { changed: boolean; archive?: () => void } {
	const sidecarPath = join(agentDir, "optimizer.json");
	if (!existsSync(sidecarPath)) return { changed: false };

	let raw: Record<string, unknown>;
	try {
		const parsed = JSON.parse(readFileSync(sidecarPath, "utf-8")) as unknown;
		if (!isObj(parsed)) throw new Error("not an object");
		raw = parsed;
	} catch (err) {
		ctx.diagnostic({
			code: "MIGRATION_FAILED",
			severity: "warning",
			path: "optimizer.json",
			message: "malformed optimizer sidecar left untouched",
			cause: err,
		});
		return { changed: false };
	}

	const existing = isObj(doc.optimizer) ? { ...doc.optimizer } : {};
	let changed = false;
	for (const key of OPTIMIZER_KEYS) {
		const value = raw[key];
		if (typeof value === "string" && !(key in existing)) {
			existing[key] = value;
			changed = true;
		}
	}
	if (changed) doc.optimizer = existing;

	const hasLegacyToon = typeof raw.toon === "string";
	const archive = () => {
		let target = `${sidecarPath}.migrated-v1`;
		if (existsSync(target)) target = `${target}.${Date.now()}`;
		try {
			renameSync(sidecarPath, target);
		} catch {
			// A competing process may have moved it — ENOENT is benign.
		}
	};

	return { changed: changed || hasLegacyToon, archive };
}
