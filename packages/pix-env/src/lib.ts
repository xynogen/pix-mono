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

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { expandHome } from "@xynogen/pix-runtime/paths";

/** Default files scanned at the repo root, later entries override earlier. */
const DEFAULT_FILES = [".env", ".env.local"] as const;
const QUOTED_VALUE = /^(?:"((?:\\.|[^"\\])*)"|'([^']*)')([ \t]*(?:#.*)?)$/;

/**
 * Parse dotenv text into key/value pairs. Handles `KEY=value`, `export KEY=`,
 * `#` comments, blank lines, and single/double quoted values. Deliberately
 * small — not a full dotenv spec (no multiline, no ${VAR} interpolation).
 * ponytail: swap for the `dotenv` package if multiline/interp is ever needed.
 */
export function parseEnv(text: string): Record<string, string> {
	const out: Record<string, string> = Object.create(null);
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
		if (!m) continue;
		const key = m[1] as string;
		let val = (m[2] ?? "").trim();
		const quoted = val.match(QUOTED_VALUE);
		if (quoted) {
			val = (quoted[1] ?? quoted[2]) as string;
			if (quoted[1] !== undefined)
				val = val.replace(
					/\\([\\"nrt])/g,
					(_, escaped: string) => ({ n: "\n", r: "\r", t: "\t" })[escaped] ?? escaped,
				);
		} else {
			// strip trailing inline comment on unquoted values
			val = val.replace(/[ \t]+#.*$/, "").trim();
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

/** Resolve an explicit env file; directories remain valid for read/info. */
export function envPath(path: string, cwd: string, directory = false): string {
	if (!path.trim() || /[\0\r\n]/.test(path)) throw new Error("invalid env path");
	const target = resolve(cwd, expandHome(path));
	if (directory && statSync(target).isDirectory()) return target;
	if (!/^\.env(?:\.[A-Za-z0-9_-]+)*$/.test(basename(target)))
		throw new Error("env filename must be .env or .env.<suffix> (for example .env.examples)");
	return target;
}

/** Explicit paths fail visibly instead of silently returning an empty registry. */
export function loadPath(path: string, cwd: string): Map<string, string> {
	const target = envPath(path, cwd, true);
	if (statSync(target).isDirectory()) return loadRegistry(target);
	const actual = envPath(realpathSync(target), cwd);
	if (!statSync(actual).isFile()) throw new Error("env path must be a regular file");
	return new Map(Object.entries(parseEnv(readFileSync(actual, "utf-8"))));
}

/** Preserve unrelated lines/comments and change exactly one assignment. */
export function editEnvText(
	text: string,
	name: string,
	value: string,
	action: "add" | "edit",
): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /[\r\n]/.test(name))
		throw new Error("invalid env variable name");
	// ponytail: single-line values only; use a full dotenv parser before supporting multiline files.
	if (/[\0\r\n]/.test(value)) throw new Error("env value must be a single line without null bytes");
	const lines = text.split("\n");
	const matches = lines.flatMap((line, i) =>
		new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line) ? [i] : [],
	);
	if (action === "add" && matches.length) throw new Error(`env variable already exists: ${name}`);
	if (action === "edit" && matches.length !== 1)
		throw new Error(`edit requires exactly one existing assignment: ${name}`);
	// Do not mistake a key-looking line inside a multiline value for an assignment.
	for (const line of lines) {
		const raw = line.match(/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/)?.[1]?.trim();
		if (raw && (raw.startsWith('"') || raw.startsWith("'"))) {
			if (!QUOTED_VALUE.test(raw))
				throw new Error("multiline or unterminated quoted env values are not supported for writes");
		}
	}
	const assignment = `${name}=${JSON.stringify(value)}`;
	if (action === "add") return `${text}${text && !text.endsWith("\n") ? "\n" : ""}${assignment}\n`;
	const index = matches[0] as number;
	const line = lines[index] as string;
	const parts = line.match(/^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*[ \t]*=[ \t]*)([^\r]*)(\r?)$/);
	if (!parts) throw new Error("unsupported env assignment format");
	const raw = parts[2] as string;
	const suffix = raw.startsWith("#")
		? ` ${raw}`
		: (raw.match(QUOTED_VALUE)?.[3] ?? raw.match(/([ \t]+#.*|[ \t]*)$/)?.[0] ?? "");
	lines[index] = `${parts[1]}${JSON.stringify(value)}${suffix}${parts[3]}`;
	return lines.join("\n");
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

export type EnvValueType = "boolean" | "int" | "float" | "string";

/** Infer a compact value type without exposing the value itself. */
export function valueType(value: string): EnvValueType {
	if (/^(?:true|false)$/i.test(value)) return "boolean";
	if (/^[+-]?\d+$/.test(value)) return "int";
	if (/^[+-]?(?:\d+\.\d*|\d*\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return "float";
	return "string";
}

/** Return sorted env names and inferred types; values never leave the registry. */
export function describeRegistry(reg: Map<string, string>): Record<string, EnvValueType> {
	return Object.fromEntries(
		[...reg.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, value]) => [key, valueType(value)]),
	);
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
