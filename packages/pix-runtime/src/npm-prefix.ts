/**
 * npm-prefix.ts — install npm packages into a private prefix directory.
 *
 * For optional, heavy add-ons a package loads on demand (ast-grep grammars, the
 * LaTeX engine). It never writes a global path or a package's own node_modules,
 * so a read-only global pix install still works. The caller gets user consent
 * first: this runs a network install.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runBinary } from "./exec.ts";

export interface PrefixInstallResult {
	ok: boolean;
	message?: string;
}

/** `npm install` `specs` (`name` or `name@version`) into `<dir>/node_modules`. */
export async function installIntoPrefix(
	dir: string,
	specs: readonly string[],
	opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<PrefixInstallResult> {
	const { signal, timeoutMs = 120_000 } = opts;
	signal?.throwIfAborted();
	try {
		await mkdir(dir, { recursive: true });
		// A minimal package.json so npm installs into this prefix cleanly.
		const pkgJson = join(dir, "package.json");
		if (!existsSync(pkgJson)) {
			await writeFile(pkgJson, JSON.stringify({ name: "pix-cache", private: true }));
		}
		const result = await runBinary("npm", ["install", "--save", "--prefix", dir, ...specs], {
			cwd: dir,
			timeoutMs,
			signal,
		});
		if (result.code === 0) return { ok: true };
		return {
			ok: false,
			message: result.timedOut
				? "installation timed out"
				: result.stderr || `npm exited ${result.code}`,
		};
	} catch (err) {
		signal?.throwIfAborted();
		return { ok: false, message: err instanceof Error ? err.message : String(err) };
	}
}
