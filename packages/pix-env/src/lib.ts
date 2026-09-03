/**
 * pix-env/lib — .env registry + reference resolution.
 *
 * The registry holds real secret values in memory. They are never written to
 * the transcript by this module. The AI only ever authors `$KEY` / `${KEY}`
 * references; resolution to the real value happens at tool_call time, gated by
 * an approval popup.
 *
 * ACCEPTED LIMITATION: once a reference is resolved into a tool's input, the
 * value may surface in that tool's rendered call or output if the tool echoes
 * it back (e.g. `echo $TOKEN`, curl -v). We guarantee the *reference* stays a
 * placeholder until the gated injection; we do NOT scrub tool output.
 * ponytail: upgrade path is a tool_result redactor that masks known values.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Default files scanned at the repo root, later entries override earlier. */
const DEFAULT_FILES = [".env", ".env.local"] as const;

/**
 * Parse dotenv text into key/value pairs. Handles `KEY=value`, `export KEY=`,
 * `#` comments, blank lines, and single/double quoted values. Deliberately
 * small — not a full dotenv spec (no multiline, no ${VAR} interpolation).
 * ponytail: swap for the `dotenv` package if multiline/interp is ever needed.
 */
export function parseEnv(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
		if (!m) continue;
		const key = m[1] as string;
		let val = (m[2] ?? "").trim();
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
			val = val.slice(1, -1);
		} else {
			// strip trailing inline comment on unquoted values
			const hash = val.indexOf(" #");
			if (hash !== -1) val = val.slice(0, hash).trim();
		}
		out[key] = val;
	}
	return out;
}

/** Which files to scan — `PIX_ENV_FILES` (comma-sep) overrides the default. */
export function envFileList(): readonly string[] {
	const override = process.env.PIX_ENV_FILES;
	if (override)
		return override
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	return DEFAULT_FILES;
}

/** Load + merge the configured env files under `cwd` into one registry. */
export function loadRegistry(cwd: string): Map<string, string> {
	const reg = new Map<string, string>();
	for (const file of envFileList()) {
		const p = join(cwd, file);
		if (!existsSync(p)) continue;
		try {
			for (const [k, v] of Object.entries(parseEnv(readFileSync(p, "utf-8")))) {
				reg.set(k, v);
			}
		} catch {
			// unreadable file — skip silently, nothing to inject
		}
	}
	return reg;
}

/** Match `$KEY` or `${KEY}` where KEY is a valid env name. */
const REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** Return the set of registry keys referenced anywhere in a string. */
export function refsIn(text: string, reg: Map<string, string>): string[] {
	const found = new Set<string>();
	for (const m of text.matchAll(REF_RE)) {
		const key = (m[1] ?? m[2]) as string;
		if (reg.has(key)) found.add(key);
	}
	return [...found];
}

/**
 * Match a braced ref carrying a bash parameter-expansion MODIFIER, e.g.
 * `${KEY:-def}`, `${KEY%/}`, `${KEY#p}`, `${KEY/a/b}`, `${KEY^^}`, `${KEY:0:5}`.
 * In bash these are handled natively via an export prelude (see shellPrelude).
 * In non-shell tools there is no interpreter to expand them, so the caller must
 * still block and nudge the model to plain $KEY/${KEY}. The char class is the
 * set of operator chars that can follow the name.
 */
const MOD_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)[:%#/^,@!*=+?-][^}]*\}/g;

/** Registry keys referenced via a braced modifier form (bare match, no dedup by caller). */
export function unsupportedRefs(text: string, reg: Map<string, string>): string[] {
	const found = new Set<string>();
	for (const m of text.matchAll(MOD_RE)) {
		const key = m[1] as string;
		if (reg.has(key)) found.add(key);
	}
	return [...found];
}

/** Union of every registry key referenced in a string in ANY form (bare, braced, modifier). */
export function allRefsIn(text: string, reg: Map<string, string>): string[] {
	return [...new Set([...refsIn(text, reg), ...unsupportedRefs(text, reg)])];
}

/**
 * Build a bash prelude that exports the given keys with their real values,
 * shell-quoted. Prepending this lets bash expand every reference form natively
 * ($KEY, ${KEY}, ${KEY%/}, ${KEY:-x}, …) instead of us re-implementing shell
 * parameter expansion. Keys not in the registry are skipped.
 */
export function shellPrelude(keys: readonly string[], reg: Map<string, string>): string {
	const lines: string[] = [];
	for (const k of keys) {
		const v = reg.get(k);
		if (v !== undefined) lines.push(`export ${k}=${shellQuote(v)}`);
	}
	return lines.length ? `${lines.join("\n")}\n` : "";
}

/** Single-quote a value for safe embedding in a POSIX shell command. */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Replace known `$KEY`/`${KEY}` references in a string with their registry
 * values. `shell=true` wraps each value in shell-safe single quotes (for the
 * bash command string); otherwise the raw value is substituted.
 */
export function resolveString(text: string, reg: Map<string, string>, shell: boolean): string {
	return text.replace(REF_RE, (whole, braced?: string, bare?: string) => {
		const key = (braced ?? bare) as string;
		if (!reg.has(key)) return whole;
		const val = reg.get(key) as string;
		return shell ? shellQuote(val) : val;
	});
}

/** Deep-walk helper: run `scan` over every string field (arrays/objects too). */
function walkStrings(input: unknown, scan: (s: string) => Iterable<string>): string[] {
	const keys = new Set<string>();
	const visit = (v: unknown): void => {
		if (typeof v === "string") {
			for (const k of scan(v)) keys.add(k);
		} else if (Array.isArray(v)) {
			for (const item of v) visit(item);
		} else if (v && typeof v === "object") {
			for (const item of Object.values(v)) visit(item);
		}
	};
	visit(input);
	return [...keys];
}

/**
 * Deep-walk a tool input object, returning the set of referenced keys across
 * all string fields (arrays + nested objects included).
 */
export function collectRefs(input: unknown, reg: Map<string, string>): string[] {
	return walkStrings(input, (s) => refsIn(s, reg));
}

/** Deep-walk variant collecting keys referenced via unsupported modifier forms. */
export function collectUnsupported(input: unknown, reg: Map<string, string>): string[] {
	return walkStrings(input, (s) => unsupportedRefs(s, reg));
}

/**
 * Mutate a tool input object in place, resolving every string field's
 * references. `shell=true` quotes values (bash command). Returns the same
 * object reference for convenience.
 */
export function resolveInput<T>(input: T, reg: Map<string, string>, shell: boolean): T {
	if (typeof input === "string")
		// SAFETY: typeof guard narrows T to string; resolveString returns string === T here.
		return resolveString(input, reg, shell) as unknown as T;
	if (Array.isArray(input)) {
		for (let i = 0; i < input.length; i++) input[i] = resolveInput(input[i], reg, shell);
		return input;
	}
	if (input && typeof input === "object") {
		const obj = input as Record<string, unknown>;
		for (const k of Object.keys(obj)) obj[k] = resolveInput(obj[k], reg, shell);
	}
	return input;
}
