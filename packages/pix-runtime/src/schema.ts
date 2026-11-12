/**
 * schema.ts — shared types, validation helpers, and immutability utilities for
 * the pix-runtime config layer.
 *
 * The runtime models config as typed *sections*. A section owns its defaults,
 * a pure `parse(raw)`, and an optional `serialize(value, defaults)`. Parsing
 * never throws: invalid fields fall back individually and push a diagnostic.
 */

export const CONFIG_FORMAT_VERSION = 1 as const;

// ── Raw document ─────────────────────────────────────────────────────────────

/** The on-disk JSON shape: sparse, `$version` plus known/unknown sections. */
export type RawDocument = Record<string, unknown>;

// ── Diagnostics ──────────────────────────────────────────────────────────────

export type ConfigDiagnosticCode =
	| "PARSE_ERROR"
	| "INVALID_VALUE"
	| "READ_FAILED"
	| "WRITE_FAILED"
	| "MIGRATION_FAILED"
	| "UNSUPPORTED_CONFIG_VERSION"
	| "LISTENER_FAILED";

export interface ConfigDiagnostic {
	code: ConfigDiagnosticCode;
	severity: "warning" | "error";
	path?: string;
	message: string;
	cause?: unknown;
	at: number;
}

/** Collects diagnostics while parsing/migrating without throwing. */
export interface ParseContext {
	diagnostic(d: Omit<ConfigDiagnostic, "at">): void;
}

// ── Section definitions ──────────────────────────────────────────────────────

export interface ConfigSection<T> {
	key: string;
	defaults: Readonly<T>;
	parse(raw: unknown, ctx: ParseContext): T;
	/**
	 * Serialize a resolved value into a sparse raw object relative to defaults.
	 * When omitted, the runtime deep-strips values equal to defaults.
	 */
	serialize?(value: T, defaults: T): unknown;
}

/** Opaque, typed handle to a registered section. */
export interface SectionHandle<K extends string, T> {
	readonly key: K;
	readonly defaults: Readonly<T>;
	/** Internal reference to the full definition. */
	readonly __section: ConfigSection<T>;
}

export function defineSection<const K extends string, T>(
	definition: ConfigSection<T> & { key: K },
): SectionHandle<K, T> {
	return {
		key: definition.key,
		defaults: definition.defaults,
		__section: definition,
	};
}

// ── Value coercion helpers (pure, never throw) ───────────────────────────────

export function isObj(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function boolOr(v: unknown, fallback: boolean): boolean {
	return typeof v === "boolean" ? v : fallback;
}

export function posNumOr(v: unknown, fallback: number): number {
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}

export function enumOr<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
	return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

export function strArr(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	return v.filter((x): x is string => typeof x === "string");
}

// ── Sparse serialization ─────────────────────────────────────────────────────

/**
 * Recursively remove entries equal to their default. Returns the number of
 * remaining keys so callers can drop empty sections. Mutates `section`.
 */
export function stripDefaults(
	section: Record<string, unknown>,
	defaults: Record<string, unknown>,
): number {
	for (const [key, defaultValue] of Object.entries(defaults)) {
		const value = section[key];
		if (isObj(value) && isObj(defaultValue)) {
			const nested = { ...value };
			if (stripDefaults(nested, defaultValue) > 0) section[key] = nested;
			else delete section[key];
		} else if (JSON.stringify(value) === JSON.stringify(defaultValue)) {
			delete section[key];
		}
	}
	return Object.keys(section).length;
}

// ── Immutability ─────────────────────────────────────────────────────────────

/** Deep-freeze a value in place and return it typed as readonly. */
export function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const key of Object.keys(value as Record<string, unknown>)) {
			deepFreeze((value as Record<string, unknown>)[key]);
		}
	}
	return value;
}

/** Deep clone a JSON-compatible value via the native structured clone. */
export function clone<T>(value: T): T {
	return structuredClone(value);
}

// ── Deep merge (objects merge, arrays/primitives replace) ────────────────────

export type DeepPartial<T> = T extends (infer U)[]
	? U[]
	: T extends object
		? { [K in keyof T]?: DeepPartial<T[K]> }
		: T;

/**
 * Merge `patch` onto `base`. Objects merge recursively; arrays replace;
 * `undefined` values are rejected (skipped). Returns a new object.
 */
export function deepMerge<T>(base: T, patch: DeepPartial<T>): T {
	// SAFETY: a non-object patch replaces base wholesale; DeepPartial<T> of a leaf is T.
	if (!isObj(base) || !isObj(patch)) return (patch as unknown as T) ?? base;
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
		if (value === undefined) continue;
		const prev = out[key];
		if (isObj(prev) && isObj(value)) {
			out[key] = deepMerge<Record<string, unknown>>(
				prev,
				value as DeepPartial<Record<string, unknown>>,
			);
		} else {
			out[key] = value;
		}
	}
	return out as T;
}

// ── Changed-path detection ───────────────────────────────────────────────────

/** Return dotted JSON paths that differ between two resolved section values. */
export function diffPaths(prefix: string, a: unknown, b: unknown): string[] {
	if (JSON.stringify(a) === JSON.stringify(b)) return [];
	if (!isObj(a) || !isObj(b)) return [prefix];
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	const out: string[] = [];
	for (const key of keys) {
		out.push(...diffPaths(prefix ? `${prefix}.${key}` : key, a[key], b[key]));
	}
	return out;
}

/** Match a changed path against subscription filters (supports `section.*`). */
export function pathMatches(changed: string, filters: readonly string[]): boolean {
	return filters.some((f) => {
		if (f === changed) return true;
		if (f.endsWith(".*")) {
			const base = f.slice(0, -2);
			return changed === base || changed.startsWith(`${base}.`);
		}
		return false;
	});
}
