/**
 * Pure logic for `/pix` → Extensions: which pix packages can be disabled, installed, or removed.
 *
 * Two kinds:
 * - members: loaded by pix-core. Turned off by name in pix.json `extensions.disabled`; pix-core
 *   skips them on the next load. Kernel members (runtime, data, pretty) and the gate stay on.
 * - standalone: separate Pi packages, never loaded by pix-core. Installed or removed with
 *   `pi install` / `pi remove`, recorded in Pi's settings.json `packages`.
 */

/** Members that cannot be turned off: every other member depends on them, or they protect the user. */
export const LOCKED_MEMBERS: ReadonlySet<string> = new Set([
	"@xynogen/pix-runtime",
	"@xynogen/pix-data",
	"@xynogen/pix-pretty",
	"@xynogen/pix-gate",
]);

/** Pix packages Pi installs on their own, next to pix-core. */
// Short names: a bare package string on its own line reads as an import to scripts/deps.test.ts.
export const STANDALONE_PACKAGES: readonly string[] = [
	"9router",
	"aria2",
	"astgrep",
	"codemode",
	"env",
	"graph",
	"hunk",
	"mcp",
	"proc",
	"python",
	"search",
	"ssh",
	"sudo",
	"themes",
	"toolbox",
	"voice",
	"web",
].map((name) => `@xynogen/pix-${name}`);

/** `@xynogen/pix-footer/extension` → `@xynogen/pix-footer`. */
export function memberPackage(specifier: string): string {
	const [scope, name] = specifier.split("/");
	return name ? `${scope}/${name}` : specifier;
}

/** `@xynogen/pix-footer` → `footer`. */
export function shortName(pkg: string): string {
	return pkg.replace(/^@xynogen\/pix-/, "");
}

/** True when pix-core should skip this member specifier on load. */
export function isMemberDisabled(specifier: string, disabled: readonly string[]): boolean {
	const pkg = memberPackage(specifier);
	return !LOCKED_MEMBERS.has(pkg) && disabled.includes(pkg);
}

/** The disabled list after toggling `pkg`. Locked members never enter the list. */
export function toggleDisabled(disabled: readonly string[], pkg: string): string[] {
	if (LOCKED_MEMBERS.has(pkg)) return [...disabled];
	return disabled.includes(pkg) ? disabled.filter((p) => p !== pkg) : [...disabled, pkg].sort();
}

/**
 * Standalone pix packages named in Pi's `packages` setting, mapped to the source Pi recorded.
 * Entries are Pi sources: `npm:@xynogen/pix-web`, `npm:@xynogen/pix-web@1.2.3`, or a local path
 * ending in `pix-web`. `pi remove` needs that exact source, so it is kept.
 */
export function installedStandalone(packages: unknown): Map<string, string> {
	const found = new Map<string, string>();
	if (!Array.isArray(packages)) return found;
	for (const entry of packages) {
		const source = typeof entry === "string" ? entry : (entry as { source?: unknown })?.source;
		if (typeof source !== "string") continue;
		const tail = source.replace(/\\/g, "/").replace(/\/+$/, "");
		for (const pkg of STANDALONE_PACKAGES) {
			const name = pkg.slice("@xynogen/".length);
			const npm = `npm:${pkg}`;
			if (tail === npm || tail.startsWith(`${npm}@`) || tail.endsWith(`/${name}`))
				found.set(pkg, source);
		}
	}
	return found;
}

/** `pi install` arguments for a standalone package; `pi remove` takes the recorded source. */
export function packageCommand(
	action: "install" | "remove",
	pkg: string,
	source?: string,
): string[] {
	if (!STANDALONE_PACKAGES.includes(pkg)) throw new Error(`Not a standalone pix package: ${pkg}`);
	return [action, action === "remove" && source ? source : `npm:${pkg}`];
}
