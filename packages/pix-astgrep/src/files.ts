import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { cancellationCheckpoint } from "@xynogen/pix-runtime/abort";
import { languageForFile } from "@xynogen/pix-runtime/ast";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage"]);

export async function collectCodeFiles(
	root: string,
	out: string[],
	cap: number,
	signal?: AbortSignal,
): Promise<void> {
	await cancellationCheckpoint(signal);
	if (out.length >= cap) return;
	let info: Awaited<ReturnType<typeof stat>>;
	try {
		info = await stat(root);
	} catch {
		return;
	}
	if (info.isFile()) {
		if (languageForFile(root)) out.push(root);
		return;
	}
	if (!info.isDirectory()) return;
	for (const entry of await readdir(root, { withFileTypes: true })) {
		await cancellationCheckpoint(signal);
		if (out.length >= cap) return;
		if (entry.isDirectory() && !SKIP_DIRS.has(entry.name))
			await collectCodeFiles(join(root, entry.name), out, cap, signal);
		else if (entry.isFile() && languageForFile(entry.name)) out.push(join(root, entry.name));
	}
}
