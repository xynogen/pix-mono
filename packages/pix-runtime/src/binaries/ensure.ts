/**
 * ensure.ts — resolve a binary, downloading it into `<agentDir>/bin` when the
 * catalog has a trusted release for this host.
 *
 * Mirrors Pi's own fd/rg downloader (latest-release redirect, system tar/unzip,
 * unique temp dir + rename) and adds SHA-256 verification when the release
 * publishes a checksum manifest. Reports progress only through `onStatus`;
 * callers decide where it appears (runtime cannot import UI code).
 */

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	createWriteStream,
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
} from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ioTimeoutSignal } from "../io.ts";
import { binDir } from "../paths.ts";
import { currentPlatform, type HostPlatform } from "../platform.ts";
import { type BinaryName, type BinarySpec, downloadAsset, hintFor, specOf } from "./catalog.ts";
import { BinaryMissingError, lookupTool, type ResolvedTool } from "./resolve.ts";

export type ToolStatus =
	| { kind: "downloading"; name: string; version: string; url: string; size?: string }
	| { kind: "installed"; name: string; path: string; version: string; verified: boolean }
	| { kind: "failed"; name: string; error: string; hint: string };

export interface EnsureOptions {
	onStatus?: (status: ToolStatus) => void;
	signal?: AbortSignal;
	env?: NodeJS.ProcessEnv;
	host?: HostPlatform;
	/** Injected fetch for tests. */
	fetch?: typeof fetch;
}

const LOOKUP_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const USER_AGENT = "pix-runtime";

export function isOffline(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.PI_OFFLINE?.toLowerCase();
	return v === "1" || v === "true" || v === "yes";
}

const inflight = new Map<string, Promise<ResolvedTool>>();

/**
 * Resolve `name`; if missing and downloadable here, download it. Concurrent
 * calls for one name share a single download. Throws {@link BinaryMissingError}.
 */
export function ensureTool(
	name: BinaryName | (string & {}),
	opts: EnsureOptions = {},
): Promise<ResolvedTool> {
	const hit = lookupTool(name, { env: opts.env, host: opts.host });
	if (hit.state === "ok" && hit.path && hit.source) {
		return Promise.resolve({ name, path: hit.path, source: hit.source });
	}
	if (hit.state === "broken")
		return Promise.reject(new BinaryMissingError(name, "broken", hit.hint, hit.error));
	const spec = specOf(name);
	const host = opts.host ?? currentPlatform();
	if (!spec || !downloadAsset(spec, host)) {
		return Promise.reject(new BinaryMissingError(name, hit.state, hit.hint));
	}
	if (isOffline(opts.env)) {
		return Promise.reject(
			new BinaryMissingError(name, "missing", hit.hint, "PI_OFFLINE is set; skipping download"),
		);
	}
	const key = `${binDir(opts.env)}::${name}`;
	const running = inflight.get(key);
	if (running) return running;
	const job = installFromRelease(name, spec, host, opts).finally(() => inflight.delete(key));
	inflight.set(key, job);
	return job;
}

/** Download + verify + extract one catalog recipe into binDir. Exported for tests. */
export async function installFromRelease(
	name: string,
	spec: BinarySpec,
	host: HostPlatform,
	opts: EnsureOptions = {},
): Promise<ResolvedTool> {
	const recipe = spec.download;
	const hint = hintFor(spec, host);
	const doFetch = opts.fetch ?? fetch;
	const fail = (error: unknown): never => {
		const message = error instanceof Error ? error.message : String(error);
		opts.onStatus?.({ kind: "failed", name, error: message, hint });
		throw new BinaryMissingError(name, "missing", hint, `download failed: ${message}`);
	};
	if (!recipe) return fail("no download recipe");

	const bin = binDir(opts.env);
	const exeName = `${name}${host.exe}`;
	const target = join(bin, exeName);
	const work = join(bin, `.pix-dl-${name}-${process.pid}-${randomBytes(4).toString("hex")}`);
	try {
		const tag = await latestTag(recipe.repo, doFetch, opts.signal);
		const version = tag.replace(/^(v|release-)/, "");
		const asset = recipe.asset(host, version);
		if (!asset) return fail(`no ${recipe.repo} asset for ${host.os}/${host.arch}`);
		const base = `https://github.com/${recipe.repo}/releases/download/${tag}`;
		const url = `${base}/${asset}`;
		opts.onStatus?.({ kind: "downloading", name, version, url, size: recipe.size });

		mkdirSync(work, { recursive: true });
		const archive = join(work, asset);
		const sha256 = await download(url, archive, doFetch, opts.signal);
		// A recipe that declares a manifest must verify. A missing manifest fails the
		// install, so a renamed or removed file cannot turn verification off quietly.
		const verified = recipe.checksums !== undefined;
		if (recipe.checksums) {
			const expected = await expectedChecksum(
				`${base}/${recipe.checksums}`,
				asset,
				doFetch,
				opts.signal,
			);
			if (expected !== sha256)
				throw new Error(`checksum mismatch for ${asset} (expected ${expected}, got ${sha256})`);
		}
		const out = join(work, "x");
		mkdirSync(out);
		extract(archive, out, host);
		const found = findFile(out, exeName);
		if (!found) throw new Error(`${exeName} not found in ${asset}`);
		if (host.os !== "win32") chmodSync(found, 0o755);
		mkdirSync(bin, { recursive: true });
		try {
			renameSync(found, target);
		} catch (err) {
			// A concurrent installer (another Pi process) may have won the rename,
			// or Windows refuses to replace an in-use exe; either way a binary exists.
			if (!existsSync(target)) throw err;
		}
		opts.onStatus?.({ kind: "installed", name, path: target, version, verified });
		return { name, path: target, source: "download", version };
	} catch (err) {
		if (err instanceof BinaryMissingError) throw err;
		return fail(err);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

/** Latest release tag via the `/releases/latest` redirect (no API quota). */
async function latestTag(
	repo: string,
	doFetch: typeof fetch,
	signal?: AbortSignal,
): Promise<string> {
	const res = await doFetch(`https://github.com/${repo}/releases/latest`, {
		redirect: "manual",
		headers: { "User-Agent": USER_AGENT },
		signal: ioTimeoutSignal(signal, LOOKUP_TIMEOUT_MS),
	});
	await res.body?.cancel().catch(() => {});
	const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
	if (!location?.includes("/releases/tag/")) {
		throw new Error(`cannot resolve latest ${repo} release (HTTP ${res.status})`);
	}
	const tag = new URL(location, "https://github.com").pathname.split("/").pop();
	if (!tag) throw new Error(`unexpected redirect for ${repo}: ${location}`);
	return decodeURIComponent(tag);
}

/** Stream `url` to `dest`, returning its SHA-256 hex. */
async function download(
	url: string,
	dest: string,
	doFetch: typeof fetch,
	signal?: AbortSignal,
): Promise<string> {
	const res = await doFetch(url, {
		headers: { "User-Agent": USER_AGENT },
		signal: ioTimeoutSignal(signal, DOWNLOAD_TIMEOUT_MS),
	});
	if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
	const hash = createHash("sha256");
	const tap = new Transform({
		transform(chunk: Buffer, _enc, cb) {
			hash.update(chunk);
			cb(null, chunk);
		},
	});
	await pipeline(
		Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
		tap,
		createWriteStream(dest),
	);
	return hash.digest("hex");
}

/** Expected hash for `asset` from a `<sha256>  <name>` manifest. Throws when the manifest or entry is missing. */
async function expectedChecksum(
	url: string,
	asset: string,
	doFetch: typeof fetch,
	signal?: AbortSignal,
): Promise<string> {
	const res = await doFetch(url, {
		headers: { "User-Agent": USER_AGENT },
		signal: ioTimeoutSignal(signal, LOOKUP_TIMEOUT_MS),
	});
	if (res.status === 404) {
		await res.body?.cancel().catch(() => {});
		throw new Error(`checksum manifest missing (HTTP 404): ${url}`);
	}
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
	const text = await res.text();
	for (const line of text.split(/\r?\n/)) {
		const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
		if (m?.[1] && m[2]?.trim() === asset) return m[1].toLowerCase();
	}
	throw new Error(`${asset} is not listed in the release checksums`);
}

function run(cmd: string, args: string[]): string | null {
	const r = spawnSync(cmd, args, { stdio: "pipe", windowsHide: true });
	if (!r.error && r.status === 0) return null;
	const msg = r.error?.message || r.stderr?.toString().trim() || `exit ${r.status}`;
	return `${cmd}: ${msg}`;
}

function windowsTar(): string {
	const root = process.env.SystemRoot ?? process.env.WINDIR;
	const sys = root ? join(root, "System32", "tar.exe") : "";
	return sys && existsSync(sys) ? sys : "tar.exe";
}

/** Extract with system tools only (same approach as Pi): no npm deps. */
function extract(archive: string, dest: string, host: HostPlatform): void {
	const failures: string[] = [];
	const attempt = (cmd: string, args: string[]): boolean => {
		const err = run(cmd, args);
		if (err) failures.push(err);
		return !err;
	};
	if (host.os === "win32") {
		if (attempt(windowsTar(), ["xf", archive, "-C", dest])) return;
		if (archive.endsWith(".zip")) {
			const ps =
				"& { param($a, $d) $ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $a -DestinationPath $d -Force }";
			if (
				attempt("powershell.exe", [
					"-NoLogo",
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					ps,
					archive,
					dest,
				])
			)
				return;
		}
	} else if (archive.endsWith(".zip")) {
		if (attempt("unzip", ["-q", archive, "-d", dest])) return;
		if (attempt("tar", ["xf", archive, "-C", dest])) return;
	} else {
		const flag = archive.endsWith(".tar.xz") ? "xJf" : "xzf";
		if (attempt("tar", [flag, archive, "-C", dest])) return;
	}
	throw new Error(`cannot extract ${archive}: ${failures.join("; ")}`);
}

function findFile(root: string, fileName: string): string | undefined {
	const stack = [root];
	while (stack.length) {
		const dir = stack.pop() as string;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isFile() && entry.name === fileName) return full;
			if (entry.isDirectory()) stack.push(full);
		}
	}
	return undefined;
}
