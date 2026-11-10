import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import type { EditOperations, WriteOperations } from "@earendil-works/pi-coding-agent";
import { runTool } from "./exec.ts";
import { ioTimeoutMs } from "./io.ts";
import { tempDir } from "./paths.ts";

/** SFTP paths use forward slashes even when the server is Windows. No local home expansion. */
export function sftpPath(path: string): string {
	if (typeof path !== "string" || !path || /[\x00-\x1f\x7f]/.test(path))
		throw new Error("Invalid SFTP path");
	const value = path.replaceAll("\\", "/");
	if (/[{}]/.test(value)) throw new Error("SFTP paths containing braces are not supported");
	if (value.startsWith("-")) return `./${value}`;
	if (value.startsWith("~"))
		throw new Error("Use a path relative to the SFTP home, or an absolute path (not ~)");
	return /^[A-Za-z]:\//.test(value) ? `/${value}` : value;
}

/** Quote for the sftp command parser, including its separate glob expansion pass. */
export function sftpQuote(path: string): string {
	if (!path || /[\x00-\x1f\x7f]/.test(path)) throw new Error("Invalid SFTP path");
	return `"${path.replace(/[\\"]/g, "\\$&")}"`;
}

export interface SftpOptions {
	host: string;
	args: string[];
	loginPassword?: string;
	signal?: AbortSignal;
}

export async function runSftp(opts: SftpOptions, commands: string[]) {
	const args = [
		"-q",
		...opts.args,
		"-o",
		`BatchMode=${opts.loginPassword ? "no" : "yes"}`,
		"-b",
		"-",
		"--",
		opts.host,
	];
	return runTool(
		opts.loginPassword ? "sshpass" : "sftp",
		opts.loginPassword ? ["-e", "sftp", ...args] : args,
		{
			input: `${commands.join("\n")}\n`,
			signal: opts.signal,
			timeoutMs: ioTimeoutMs(),
			env: opts.loginPassword ? { ...process.env, SSHPASS: opts.loginPassword } : process.env,
		},
	);
}

/** Keep file bytes out of process output; all temporary local files are private and cleaned up. */
export async function withSftp<T>(
	opts: SftpOptions,
	run: (files: EditOperations & WriteOperations) => Promise<T>,
): Promise<T> {
	opts.signal?.throwIfAborted();
	const root = await mkdtemp(join(tempDir(), "pix-sftp-"));
	const downloaded = new Map<string, string>();
	const command = async (commands: string[], signal: AbortSignal | undefined = opts.signal) => {
		const result = await runSftp({ ...opts, signal }, commands);
		if (result.code !== 0 || result.truncated || result.timedOut)
			throw new Error(result.stderr.trim() || `SFTP failed (${result.code ?? "stopped"})`);
		return result.stdout;
	};
	const get = async (path: string) => {
		const listing = await command([`ls -ln ${sftpQuote(path)}`]);
		const entry = listing.split("\n").find((line) => /^[-ld][rwxStTs-]{9}\s/.test(line));
		if (!entry?.startsWith("-"))
			throw new Error(
				"Remote path must be a regular file (symlinks and directories are not supported)",
			);
		const size = Number(entry.trim().split(/\s+/)[4]);
		if (!Number.isSafeInteger(size) || size < 0 || size > 50 * 1024 * 1024)
			throw new Error("Remote file exceeds the 50MB working limit or has an invalid size");
		const local = join(root, randomUUID());
		await command([`get -p ${sftpQuote(path)} ${sftpQuote(local.replaceAll("\\", "/"))}`]);
		const info = await stat(local);
		if (info.size > 50 * 1024 * 1024) throw new Error("Remote file exceeds the 50MB working limit");
		downloaded.set(path, local);
		return local;
	};
	const files: EditOperations & WriteOperations = {
		access: async () => {
			opts.signal?.throwIfAborted();
		},
		readFile: async (path) => readFile(await get(path)),
		mkdir: async (path) => {
			// SFTP has no recursive mkdir. Ignore failures here; the final upload must still succeed.
			const parts = path.replaceAll("\\", "/").split("/");
			for (let i = 1; i <= parts.length; i++) {
				const dir = parts.slice(0, i).join("/");
				if (dir && dir !== "." && !/^[A-Za-z]:$/.test(dir))
					await command([`-mkdir ${sftpQuote(dir)}`]);
			}
		},
		writeFile: async (path, content) => {
			let local = downloaded.get(path);
			if (local) {
				const original = await readFile(local);
				const current = await readFile(await get(path));
				if (!original.equals(current))
					throw new Error("Remote file changed since read; read again before editing");
			} else {
				try {
					local = await get(path);
				} catch (error) {
					opts.signal?.throwIfAborted();
					if (
						!/(?:^|\n)(?:Can.t ls: .* not found|.*: No such file or directory)\s*$/i.test(
							error instanceof Error ? error.message : String(error),
						)
					)
						throw error;
					local = join(root, randomUUID());
				}
			}
			opts.signal?.throwIfAborted();
			await writeFile(local, content, { encoding: "utf8", mode: 0o600 });
			const temporary = `${posix.dirname(path)}/.pix-${randomUUID()}.tmp`;
			try {
				await command([`put -p ${sftpQuote(local.replaceAll("\\", "/"))} ${sftpQuote(temporary)}`]);
				// Never remove the destination to emulate overwrite: a server without rename-overwrite fails safely.
				// ponytail: SFTP has no compare-and-swap; external writers can race the recheck. Use a server-side lock for concurrent writers.
				await command([`rename ${sftpQuote(temporary)} ${sftpQuote(path)}`]);
			} catch (error) {
				// The target remains intact before rename. Cleanup uses its own deadline, not the cancelled caller.
				try {
					await command([`rm ${sftpQuote(temporary)}`], AbortSignal.timeout(ioTimeoutMs()));
				} catch (cleanupError) {
					throw new Error(`SFTP write failed; temporary file may remain at ${temporary}`, {
						cause: new AggregateError([error, cleanupError]),
					});
				}
				throw error;
			}
		},
	};
	try {
		return await run(files);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
