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

/**
 * Deep-walk a tool input object, returning the set of referenced keys across
 * all string fields (arrays + nested objects included).
 */
export function collectRefs(input: unknown, reg: Map<string, string>): string[] {
	const keys = new Set<string>();
	const visit = (v: unknown): void => {
		if (typeof v === "string") {
			for (const k of refsIn(v, reg)) keys.add(k);
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
 * Mutate a tool input object in place, resolving every string field's
 * references. `shell=true` quotes values (bash command). Returns the same
 * object reference for convenience.
 */
export function resolveInput<T>(input: T, reg: Map<string, string>, shell: boolean): T {
	if (typeof input === "string") return resolveString(input, reg, shell) as unknown as T;
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
