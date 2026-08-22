/**
 * deps.test.ts — repo-wide dependency hygiene checks.
 *
 * Guards against workspace:* protocol and bare "*" ranges leaking
 * into published package.json files (see #2, #4).
 * Also verifies pix-core dependency pins stay in sync with each
 * package's actual version.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const packagesDir = join(import.meta.dir, "..", "packages");

interface PkgJson {
	name: string;
	version: string;
	main?: string;
	private?: boolean;
	pi?: {
		extensions?: string[];
		themes?: string | string[];
	};
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	exports?: Record<string, string>;
}

const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

function sourceFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...sourceFiles(path));
		else if (/\.[cm]?[jt]sx?$/.test(entry.name)) files.push(path);
	}
	return files;
}

function internalImports(
	dir: string,
	productionOnly = false,
): { file: string; specifier: string }[] {
	const imports: { file: string; specifier: string }[] = [];
	const files = sourceFiles(dir).filter(
		(file) => !productionOnly || !/\.test\.[cm]?[jt]sx?$/.test(file),
	);
	for (const file of files) {
		const source = readFileSync(file, "utf8");
		for (const match of source.matchAll(/(?:from\s*|import\s*\()(["'])(@xynogen\/[^"']+)\1/g)) {
			if (match[2]) imports.push({ file, specifier: match[2] });
		}
	}
	return imports;
}

// Collect all publishable packages
const pkgs: { name: string; dir: string; pkg: PkgJson }[] = [];
for (const entry of readdirSync(packagesDir)) {
	const pkgPath = join(packagesDir, entry, "package.json");
	if (!existsSync(pkgPath)) continue;
	const pkg: PkgJson = JSON.parse(readFileSync(pkgPath, "utf8"));
	if (pkg.private) continue;
	pkgs.push({ name: pkg.name, dir: entry, pkg });
}

describe("package onboarding", () => {
	test("package names and Pi manifest paths match the workspace", () => {
		const violations: string[] = [];
		for (const { name, dir, pkg } of pkgs) {
			if (name !== `@xynogen/${dir}`)
				violations.push(`${dir}: expected name @xynogen/${dir}, got ${name}`);
			const entries = [...(pkg.pi?.extensions ?? [])];
			const themes = pkg.pi?.themes;
			if (typeof themes === "string") entries.push(themes);
			else if (themes) entries.push(...themes);
			for (const entry of entries) {
				if (!existsSync(join(packagesDir, dir, entry)))
					violations.push(`${name}: missing pi entry ${entry}`);
			}
		}
		expect(violations).toEqual([]);
	});

	test("uninstaller covers every package except its documented updater exception", () => {
		const uninstaller = readFileSync(join(import.meta.dir, "uninstall.sh"), "utf8");
		const violations = pkgs
			.filter(({ name }) => name !== "@xynogen/pix-update")
			.filter(({ name }) => !uninstaller.includes(`npm:${name}`))
			.map(({ name }) => `${name}: missing from uninstall.sh`);
		expect(violations).toEqual([]);
	});
});

describe("dependency architecture", () => {
	test("internal dependency graph is acyclic", () => {
		const graph = new Map(
			pkgs.map(({ name, pkg }) => [
				name,
				Object.keys(pkg.dependencies ?? {}).filter((dep) => dep.startsWith("@xynogen/")),
			]),
		);
		const visiting = new Set<string>();
		const visited = new Set<string>();
		const violations: string[] = [];
		const visit = (name: string, path: string[]) => {
			if (visiting.has(name)) {
				violations.push([...path, name].join(" → "));
				return;
			}
			if (visited.has(name)) return;
			visiting.add(name);
			for (const dep of graph.get(name) ?? []) visit(dep, [...path, name]);
			visiting.delete(name);
			visited.add(name);
		};
		for (const name of graph.keys()) visit(name, []);
		expect(violations).toEqual([]);
	});

	test("dependencies follow shared-layer boundaries", () => {
		const shared = new Set(["@xynogen/pix-runtime", "@xynogen/pix-data", "@xynogen/pix-pretty"]);
		const allowedFeatureEdges = new Set(["@xynogen/pix-skills → @xynogen/pix-gate"]);
		const violations: string[] = [];
		for (const { name, pkg } of pkgs) {
			for (const dep of Object.keys(pkg.dependencies ?? {}).filter((item) =>
				item.startsWith("@xynogen/"),
			)) {
				const edge = `${name} → ${dep}`;
				const allowed =
					name === "@xynogen/pix-core" ||
					((name === "@xynogen/pix-data" || name === "@xynogen/pix-pretty") &&
						dep === "@xynogen/pix-runtime") ||
					(!shared.has(name) && shared.has(dep)) ||
					allowedFeatureEdges.has(edge);
				if (!allowed) violations.push(edge);
			}
		}
		expect(violations).toEqual([]);
	});

	test("runtime dependencies have production imports", () => {
		const violations: string[] = [];
		for (const { name, dir, pkg } of pkgs) {
			const imported = new Set(
				internalImports(join(packagesDir, dir, "src"), true).map(({ specifier }) =>
					specifier.split("/").slice(0, 2).join("/"),
				),
			);
			for (const dep of Object.keys(pkg.dependencies ?? {}).filter((item) =>
				item.startsWith("@xynogen/"),
			)) {
				if (!imported.has(dep)) violations.push(`${name} → ${dep}`);
			}
		}
		expect(violations).toEqual([]);
	});

	test("production imports declare their internal dependencies", () => {
		const violations: string[] = [];
		for (const { name, dir, pkg } of pkgs) {
			const declared = new Set(DEP_FIELDS.flatMap((field) => Object.keys(pkg[field] ?? {})));
			for (const { file, specifier } of internalImports(join(packagesDir, dir, "src"))) {
				const dep = specifier.split("/").slice(0, 2).join("/");
				if (dep !== name && !declared.has(dep))
					violations.push(`${name}: ${file} imports undeclared ${dep}`);
			}
		}
		expect(violations).toEqual([]);
	});

	test("packages do not import another package through src internals", () => {
		const violations = pkgs.flatMap(({ name, dir }) =>
			internalImports(join(packagesDir, dir, "src"))
				.filter(({ specifier }) => /\/src(?:\/|$)/.test(specifier))
				.map(({ file, specifier }) => `${name}: ${file} imports ${specifier}`),
		);
		expect(violations).toEqual([]);
	});

	test("public export targets exist", () => {
		const violations = pkgs.flatMap(({ name, dir, pkg }) =>
			Object.entries(pkg.exports ?? {})
				.filter(
					([, target]) => !target.includes("*") && !existsSync(join(packagesDir, dir, target)),
				)
				.map(([key, target]) => `${name}: ${key} targets missing ${target}`),
		);
		expect(violations).toEqual([]);
	});

	test("Pi extensions expose a public extension entrypoint", () => {
		const violations = pkgs
			.filter(({ pkg }) => (pkg.pi?.extensions?.length ?? 0) > 0)
			.filter(({ dir, pkg }) => {
				const extension = pkg.pi?.extensions?.[0]?.replace(/^\.\//, "");
				const main = pkg.main?.replace(/^\.\//, "");
				if (!main || extension === main || pkg.exports?.["./extension"]) return false;
				const mainSource = readFileSync(join(packagesDir, dir, main), "utf8");
				return !/export\s*\{\s*default\s*\}\s*from/.test(mainSource);
			})
			.map(({ name }) => `${name}: extension differs from main but has no public entrypoint`);
		expect(violations).toEqual([]);
	});
});

describe("dependency hygiene", () => {
	test("no workspace: protocol in any published package", () => {
		const violations: string[] = [];
		for (const { name, pkg } of pkgs) {
			for (const field of DEP_FIELDS) {
				const deps = pkg[field];
				if (!deps) continue;
				for (const [dep, range] of Object.entries(deps)) {
					if (range.startsWith("workspace:")) {
						violations.push(`${name} → ${field}.${dep}: "${range}"`);
					}
				}
			}
		}
		expect(violations).toEqual([]);
	});

	test("no bare * ranges for @xynogen/ deps in any published package", () => {
		const violations: string[] = [];
		for (const { name, pkg } of pkgs) {
			for (const field of DEP_FIELDS) {
				const deps = pkg[field];
				if (!deps) continue;
				for (const [dep, range] of Object.entries(deps)) {
					if (dep.startsWith("@xynogen/") && range === "*") {
						violations.push(`${name} → ${field}.${dep}: "*"`);
					}
				}
			}
		}
		expect(violations).toEqual([]);
	});

	test("all @xynogen/ deps use caret ranges", () => {
		const violations: string[] = [];
		for (const { name, pkg } of pkgs) {
			for (const field of DEP_FIELDS) {
				const deps = pkg[field];
				if (!deps) continue;
				for (const [dep, range] of Object.entries(deps)) {
					if (dep.startsWith("@xynogen/") && !range.startsWith("^")) {
						violations.push(`${name} → ${field}.${dep}: "${range}" (expected ^x.y.z)`);
					}
				}
			}
		}
		expect(violations).toEqual([]);
	});

	test("pix-core dependency pins match each package's actual version", () => {
		const corePkg = pkgs.find((p) => p.name === "@xynogen/pix-core");
		if (!corePkg) throw new Error("pix-core not found in packages/");
		const coreDeps = corePkg.pkg.dependencies ?? {};
		const violations: string[] = [];

		for (const [dep, range] of Object.entries(coreDeps)) {
			if (!dep.startsWith("@xynogen/")) continue;
			const pkgName = dep.replace("@xynogen/", "");
			const target = pkgs.find((p) => p.dir === pkgName);
			if (!target) {
				violations.push(`${dep}: package not found in packages/`);
				continue;
			}
			const pinBase = range.replace(/^[\^~>=<]*/, "");
			if (pinBase !== target.pkg.version) {
				violations.push(
					`${dep}: pix-core pins ${range} (base ${pinBase}) but actual is ${target.pkg.version}`,
				);
			}
		}

		expect(violations).toEqual([]);
	});

	test("pix-core activates every direct Pix dependency", () => {
		const core = pkgs.find((p) => p.name === "@xynogen/pix-core");
		if (!core) throw new Error("pix-core not found in packages/");
		const extension = readFileSync(join(packagesDir, "pix-core", "src", "extension.ts"), "utf8");
		const violations = Object.keys(core.pkg.dependencies ?? {})
			.filter((name) => name.startsWith("@xynogen/"))
			.filter((name) => !extension.includes(`from "${name}`))
			.map((name) => `${name}: dependency is not imported by pix-core/src/extension.ts`);
		expect(violations).toEqual([]);
	});

	test("every standalone Pix extension is offered by the installer", () => {
		const core = pkgs.find((p) => p.name === "@xynogen/pix-core");
		if (!core) throw new Error("pix-core not found in packages/");
		const bundled = new Set<string>([core.name]);
		const pending = Object.keys(core.pkg.dependencies ?? {}).filter((name) =>
			name.startsWith("@xynogen/"),
		);
		while (pending.length > 0) {
			const name = pending.pop();
			if (!name || bundled.has(name)) continue;
			bundled.add(name);
			const pkg = pkgs.find((candidate) => candidate.name === name);
			pending.push(
				...Object.keys(pkg?.pkg.dependencies ?? {}).filter((dep) => dep.startsWith("@xynogen/")),
			);
		}

		const installer = readFileSync(join(import.meta.dir, "install.sh"), "utf8");
		const violations = pkgs
			.filter(({ name, pkg }) => pkg.pi && name !== "@xynogen/pix-themes" && !bundled.has(name))
			.filter(({ name }) => !installer.includes(`npm:${name}|`))
			.map(({ name }) => `${name}: not bundled by pix-core or listed in OPTIN_PIX_PACKAGES`);

		expect(violations).toEqual([]);
	});
});
