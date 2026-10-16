import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runToolSync } from "@xynogen/pix-runtime/exec";

const PRE_COMMIT = `#!/bin/sh
# pix-mono pre-commit
# ponytail: check the working tree without rewriting/staging; CI checks the committed snapshot.
set -e
bun run check
bun run typecheck
exec bun run test
`;

export function installHooks(cwd: string): string | undefined {
	const git = (args: string[]) => runToolSync("git", args, { cwd });
	const common = git(["rev-parse", "--git-common-dir"]);
	if (common.code !== 0) return undefined; // Source archives have no Git hooks to install.
	const configured = git(["config", "--get", "core.hooksPath"]);
	if (configured.code !== 0 && configured.code !== 1) throw new Error(configured.stderr);
	const custom = configured.code === 0 ? configured.stdout.trim() : undefined;
	if (custom !== undefined && custom !== ".githooks")
		throw new Error(`Preserving custom core.hooksPath: ${custom}. Migrate it explicitly first.`);
	const local = git(["config", "--local", "--get", "core.hooksPath"]);
	if (custom === ".githooks" && local.stdout.trim() !== custom)
		throw new Error("Preserving inherited core.hooksPath; migrate it explicitly first.");
	const directory = resolve(cwd, common.stdout.trim(), "hooks");
	const target = join(directory, "pre-commit");
	mkdirSync(directory, { recursive: true });
	try {
		writeFileSync(target, PRE_COMMIT, { flag: "wx", mode: 0o755 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		if (readFileSync(target, "utf8") !== PRE_COMMIT)
			throw new Error(`Preserving existing hook: ${target}. Merge it manually first.`);
	}
	chmodSync(target, 0o755);
	if (custom === ".githooks") {
		const unset = git(["config", "--local", "--unset-all", "core.hooksPath"]);
		if (unset.code !== 0) throw new Error(unset.stderr || "Cannot remove legacy core.hooksPath");
		const effective = git(["config", "--get", "core.hooksPath"]);
		if (effective.code !== 1)
			throw new Error("An inherited core.hooksPath still overrides the installed hook; migrate it explicitly.");
	}
	return target;
}

if (import.meta.main) {
	const target = installHooks(process.cwd());
	console.log(target ? `Installed Git hook: ${target}` : "No Git repository; hook setup skipped.");
}
