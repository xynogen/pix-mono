/**
 * binaries.test.ts — every catalogued binary is started through pix-runtime.
 *
 * A bare `spawn("ssh", …)` / `execFile("git", …)` / `pi.exec("npm", …)` skips
 * binary.json, Pi's bin dir and known install dirs, fails on Windows `.cmd`
 * shims, and reports a bare ENOENT instead of the install hint. Use
 * `@xynogen/pix-runtime/exec` (runTool/spawnTool/runToolSync) or
 * `@xynogen/pix-runtime/os` (openTarget, runGit, readClipboardImage).
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { BINARY_NAMES } from "../packages/pix-runtime/src/binaries/catalog.ts";

const root = join(import.meta.dir, "..");
const packagesDir = join(root, "packages");

/** Where starting a catalog binary directly is the implementation, not a bypass. */
const ALLOWED = new Set([
	"packages/pix-runtime/src/exec.ts",
	"packages/pix-runtime/src/binaries/ensure.ts", // system tar/unzip/powershell for extraction
	"packages/pix-runtime/src/binaries/resolve.ts", // version probe of an already-resolved path
]);

function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
		const p = join(dir, name);
		if (statSync(p).isDirectory()) sourceFiles(p, out);
		else if (
			/\.ts$/.test(name) &&
			!/\.test\.ts$/.test(name) &&
			!p.includes(`${join("", "test", "")}`)
		)
			out.push(p);
	}
	return out;
}

const names = BINARY_NAMES.map((n) => n.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")).join("|");
/** spawn/spawnSync/execFile/execFileSync/exec/pi.exec with a catalog name as a string literal. */
const BARE = new RegExp(
	String.raw`\b(?:spawn|spawnSync|execFile|execFileSync|execSync|\.exec)\(\s*["'\x60](?:${names})(?:\.exe)?["'\x60]`,
);

describe("catalog binaries go through pix-runtime", () => {
	test("no bare spawn/exec of a catalogued binary", () => {
		const offenders: string[] = [];
		for (const file of sourceFiles(packagesDir)) {
			const rel = relative(root, file).replaceAll("\\", "/");
			if (ALLOWED.has(rel)) continue;
			readFileSync(file, "utf8")
				.split("\n")
				.forEach((line, i) => {
					if (BARE.test(line) && !/^\s*(\/\/|\*)/.test(line))
						offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
				});
		}
		expect(offenders).toEqual([]);
	});
});
