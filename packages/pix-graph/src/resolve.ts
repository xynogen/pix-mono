import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

/** Nearest `package.json` facts needed to resolve workspace imports. */
interface PackageInfo {
	name: string;
	/** Repo-relative POSIX dir ("." for the repo root). */
	dir: string;
	exports?: unknown;
	main?: string;
}

export interface ImportResolver {
	/** Resolve `spec` imported from repo-relative `fromRel` to a scanned repo-relative file. */
	resolve(fromRel: string, spec: string): string | undefined;
	/** Name of the nearest named package that owns a repo-relative file. */
	packageOf(rel: string): string | undefined;
	/** True when `spec` names a package found among the scanned files. */
	isWorkspace(spec: string): boolean;
}

const PROBE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
// TS sources import `./x.js` to mean `./x.ts`.
const JS_TO_TS: Record<string, string> = {
	".js": ".ts",
	".jsx": ".tsx",
	".mjs": ".mts",
	".cjs": ".cts",
};
// Runtime conditions win over `types`, which usually points at a .d.ts.
const CONDITIONS = ["bun", "import", "node", "default", "require"];

/** First runtime target in an `exports` value (string, conditions object, or fallback array). */
function pickTarget(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		for (const item of value) {
			const hit = pickTarget(item);
			if (hit) return hit;
		}
		return undefined;
	}
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	for (const key of [...CONDITIONS, ...Object.keys(record)]) {
		const hit = pickTarget(record[key]);
		if (hit) return hit;
	}
	return undefined;
}

/** Map a package subpath (`.` or `./x`) through `exports`, including one-`*` patterns. */
export function exportTarget(exports: unknown, subpath: string): string | undefined {
	if (typeof exports === "string" || Array.isArray(exports)) {
		return subpath === "." ? pickTarget(exports) : undefined;
	}
	if (!exports || typeof exports !== "object") return undefined;
	const map = exports as Record<string, unknown>;
	// An exports object without "." keys is a conditions object for ".".
	if (!Object.keys(map).some((k) => k.startsWith("."))) {
		return subpath === "." ? pickTarget(map) : undefined;
	}
	if (subpath in map) return pickTarget(map[subpath]);
	for (const [key, value] of Object.entries(map)) {
		const star = key.indexOf("*");
		if (star < 0) continue;
		const pre = key.slice(0, star);
		const post = key.slice(star + 1);
		if (subpath.length < pre.length + post.length) continue;
		if (!subpath.startsWith(pre) || !subpath.endsWith(post)) continue;
		const hit = pickTarget(value);
		if (hit) return hit.replace("*", subpath.slice(pre.length, subpath.length - post.length));
	}
	return undefined;
}

/**
 * Resolve relative and workspace-package imports against the scanned file set.
 * Workspace packages come from the nearest `package.json` (name + exports/main)
 * of scanned files. External modules (`node:fs`, npm deps) stay unresolved.
 * ponytail: no tsconfig `paths` support; such aliases fall back to unique-name call matching.
 */
export function createResolver(rels: string[], repoRoot: string): ImportResolver {
	const files = new Set(rels);
	const pkgByDir = new Map<string, PackageInfo | null>();
	const pkgByName = new Map<string, PackageInfo>();

	const readPackage = (dir: string): PackageInfo | null => {
		const cached = pkgByDir.get(dir);
		if (cached !== undefined) return cached;
		let info: PackageInfo | null = null;
		const path = join(repoRoot, dir, "package.json");
		if (existsSync(path)) {
			try {
				const json = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
				if (typeof json.name === "string" && json.name) {
					info = {
						name: json.name,
						dir,
						exports: json.exports,
						...(typeof json.main === "string" ? { main: json.main } : {}),
					};
				}
			} catch {
				// A broken package.json only loses workspace resolution for that package.
			}
		}
		pkgByDir.set(dir, info);
		return info;
	};

	const ownerOf = (rel: string): PackageInfo | undefined => {
		let dir = posix.dirname(rel);
		for (;;) {
			const info = readPackage(dir);
			if (info) return info;
			if (dir === "." || dir === "/" || dir === "") return undefined;
			dir = posix.dirname(dir);
		}
	};

	for (const rel of rels) {
		const info = ownerOf(rel);
		if (info && !pkgByName.has(info.name)) pkgByName.set(info.name, info);
	}

	const probe = (base: string): string | undefined => {
		const ext = posix.extname(base);
		const swapped = JS_TO_TS[ext];
		const candidates = [
			base,
			...(swapped ? [base.slice(0, -ext.length) + swapped] : []),
			...PROBE_EXTENSIONS.map((e) => base + e),
			...PROBE_EXTENSIONS.map((e) => `${base}/index${e}`),
		];
		return candidates.find((c) => files.has(c));
	};

	const packageName = (spec: string): string => {
		const parts = spec.split("/");
		return spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? "");
	};

	return {
		resolve(fromRel, spec) {
			if (spec.startsWith(".")) {
				return probe(posix.normalize(posix.join(posix.dirname(fromRel), spec)));
			}
			const name = packageName(spec);
			const pkg = pkgByName.get(name);
			if (!pkg) return undefined;
			const subpath = `.${spec.slice(name.length)}`;
			const target =
				exportTarget(pkg.exports, subpath) ??
				(pkg.exports === undefined
					? subpath === "."
						? (pkg.main ?? "index")
						: subpath
					: undefined);
			return target ? probe(posix.normalize(posix.join(pkg.dir, target))) : undefined;
		},
		packageOf: (rel) => ownerOf(rel)?.name,
		isWorkspace: (spec) => !spec.startsWith(".") && pkgByName.has(packageName(spec)),
	};
}
