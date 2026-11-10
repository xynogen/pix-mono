/**
 * dev-link.ts — point Pi at this repo's packages, so edits load without an npm publish.
 *
 *   bun run dev:link                     # link every package
 *   bun run dev:link pix-bash pix-core   # link these plus their @xynogen/* dependencies
 *   bun run dev:unlink [names...]        # restore the npm-installed copies
 *
 * Names match with or without the @xynogen/ scope. Links go into Pi's npm dir
 * (PI_NPM_DIR, default <agentDir>/npm) and into the repo's own node_modules, so
 * @xynogen/* imports resolve from a link target. Packages with Pi resources are
 * registered in settings.json by local path, except pix-core members: pix-core
 * boots them in-process, and a second entry registers their tools twice.
 *
 * Restart Pi afterwards. A `pi install` replaces the links; run this again to relink.
 */
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { agentDir } from "@xynogen/pix-runtime/paths";

type Pkg = {
	name: string;
	dependencies?: Record<string, string>;
	pi?: { extensions?: string[]; themes?: string | string[] };
};
type Entry = string | { source?: string };

export type DevLinkOptions = {
	root: string;
	npmDir: string;
	settingsFile: string;
	unlink: boolean;
	names: string[];
};

const scoped = (name: string) => (name.startsWith("@xynogen/") ? name : `@xynogen/${name}`);
// Pi settings keep "/" paths on every OS (the old bash script wrote them that way too).
const slash = (path: string) => path.replaceAll("\\", "/");
const isLink = (path: string) => {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
};

/** Unlink a link without following it. `rm -r` through a Windows junction deletes the repo files. */
function remove(path: string): void {
	if (isLink(path)) unlinkSync(path);
	else rmSync(path, { recursive: true, force: true });
}

export function devLink({ root, npmDir, settingsFile, unlink, names }: DevLinkOptions): void {
	const packagesDir = join(root, "packages");
	const pkgs = new Map<string, { dir: string; pkg: Pkg }>();
	// readdir order differs per OS and filesystem; sort so settings.json entries are stable.
	for (const entry of readdirSync(packagesDir).sort()) {
		const file = join(packagesDir, entry, "package.json");
		if (!existsSync(file)) continue;
		const pkg: Pkg = JSON.parse(readFileSync(file, "utf8"));
		pkgs.set(pkg.name, { dir: join(packagesDir, entry), pkg });
	}
	const closure = (start: string[]) => {
		const seen = new Set<string>();
		const stack = [...start];
		while (stack.length > 0) {
			const name = stack.pop() as string;
			if (seen.has(name)) continue;
			seen.add(name);
			for (const dep of Object.keys(pkgs.get(name)?.pkg.dependencies ?? {}))
				if (dep.startsWith("@xynogen/")) stack.push(dep);
		}
		return seen;
	};
	const wanted = names.length > 0 ? closure(names.map(scoped)) : new Set(pkgs.keys());
	const coreMembers = closure(["@xynogen/pix-core"]);
	coreMembers.delete("@xynogen/pix-core");

	const piModules = join(npmDir, "node_modules", "@xynogen");
	const repoModules = join(root, "node_modules", "@xynogen");
	mkdirSync(piModules, { recursive: true });
	mkdirSync(repoModules, { recursive: true });
	const settings: { packages?: Entry[] } | undefined = existsSync(settingsFile)
		? JSON.parse(readFileSync(settingsFile, "utf8"))
		: undefined;
	const entries = Array.isArray(settings?.packages) ? settings.packages : [];
	const before = JSON.stringify(entries);
	const sourceOf = (entry: Entry) =>
		slash((typeof entry === "string" ? entry : entry?.source) ?? "");
	let count = 0;

	for (const [name, { dir, pkg }] of pkgs) {
		if (!wanted.has(name)) continue;
		const short = name.slice("@xynogen/".length);
		const links = [join(piModules, short), join(repoModules, short)];
		const local = slash(dir);
		const owns = (entry: Entry) => [`npm:${name}`, local].includes(sourceOf(entry));
		const themes = pkg.pi?.themes;
		const hasResources =
			Boolean(pkg.pi?.extensions?.length) || typeof themes === "string" || Array.isArray(themes);
		const register = hasResources && !coreMembers.has(name);

		if (unlink) {
			// Restore only what this script linked; leave real npm copies alone.
			if (isLink(links[0] as string)) {
				console.log(`↩ unlinked ${name}`);
				count++;
			}
			for (const link of links) if (isLink(link)) unlinkSync(link);
		} else {
			for (const link of links) {
				remove(link);
				symlinkSync(dir, link, "junction"); // Junction on Windows (no admin); type is ignored elsewhere.
			}
			console.log(`→ linked ${name} → ${local}`);
			count++;
		}
		if (!hasResources) continue;
		const index = entries.findIndex(owns);
		const keep = !unlink && register && index !== -1 ? entries[index] : undefined;
		for (let i = entries.length - 1; i >= 0; i--)
			if (owns(entries[i] as Entry)) entries.splice(i, 1);
		if (unlink || !register) continue;
		// Keep an object entry's options; only its source switches from npm to the local path.
		const entry =
			keep === undefined || typeof keep === "string" ? local : { ...keep, source: local };
		entries.splice(index === -1 ? entries.length : index, 0, entry);
	}

	if (settings && JSON.stringify(entries) !== before) {
		settings.packages = entries;
		writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
		console.log(`Updated ${slash(settingsFile)}`);
	}
	console.log(
		`\n${unlink ? "Restored" : "Linked"} ${count} package(s). Restart your Pi session to reload.`,
	);
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const unlink = args[0] === "--unlink";
	const root = join(import.meta.dir, "..");
	if (!unlink) {
		console.log("Installing workspace dependencies from frozen lockfile...");
		// process.execPath is this Bun, so no PATH lookup or Windows .cmd shim is involved.
		const install = Bun.spawnSync([process.execPath, "install", "--frozen-lockfile"], {
			cwd: root,
			stdio: ["inherit", "inherit", "inherit"],
		});
		if (install.exitCode !== 0) process.exit(install.exitCode ?? 1);
	}
	devLink({
		root,
		npmDir: process.env.PI_NPM_DIR ?? join(agentDir(), "npm"),
		settingsFile: join(agentDir(), "settings.json"),
		unlink,
		names: unlink ? args.slice(1) : args,
	});
}
