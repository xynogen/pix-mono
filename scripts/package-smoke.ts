#!/usr/bin/env bun
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "bun";

const root = join(import.meta.dir, "..");
const packagesDir = join(root, "packages");
const temp = mkdtempSync(join(tmpdir(), "pix-pack-smoke-"));

async function run(argv: string[], cwd: string): Promise<void> {
	const child = spawn(argv, { cwd, stdout: "inherit", stderr: "inherit" });
	const code = await child.exited;
	if (code !== 0) throw new Error(`${argv.join(" ")} failed (exit ${code})`);
}

try {
	const tarballs: string[] = [];
	const imports: string[] = [];
	for (const dir of readdirSync(packagesDir)) {
		const packageDir = join(packagesDir, dir);
		const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
			private?: boolean;
			name: string;
			main?: string;
			exports?: Record<string, unknown>;
			pi?: { extensions?: string[] };
		};
		if (manifest.private) continue;
		if (manifest.main || manifest.exports?.["."]) {
			imports.push(`import(${JSON.stringify(manifest.name)})`);
		}
		for (const key of Object.keys(manifest.exports ?? {})) {
			if (key !== "." && !key.includes("*")) {
				imports.push(`import(${JSON.stringify(`${manifest.name}${key.slice(1)}`)})`);
			}
		}
		for (const entry of manifest.pi?.extensions ?? []) {
			const installed = join(temp, "node_modules", manifest.name, entry);
			imports.push(`import(${JSON.stringify(pathToFileURL(installed).href)})`);
		}
		const filename = `${dir}.tgz`;
		await run(
			["bun", "pm", "pack", "--ignore-scripts", "--quiet", "--filename", join(temp, filename)],
			packageDir,
		);
		tarballs.push(join(temp, filename));
	}

	await Bun.write(
		join(temp, "package.json"),
		JSON.stringify({ name: "pix-package-smoke", private: true, type: "module" }),
	);
	await run(
		[
			"npm",
			"install",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			"--legacy-peer-deps",
			"@earendil-works/pi-ai@latest",
			"@earendil-works/pi-coding-agent@latest",
			"@earendil-works/pi-tui@latest",
			...tarballs,
		],
		temp,
	);

	await run(["bun", "-e", `await Promise.all([${imports.join(",")}])`], temp);
	console.log(`Package smoke passed: ${tarballs.length} tarballs installed and imported.`);
} finally {
	rmSync(temp, { recursive: true, force: true });
}
