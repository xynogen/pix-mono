/**
 * os.ts — jobs that need a different program on each OS, behind one call.
 *
 * Packages ask for the job ("open this URL", "read the clipboard image"); this
 * module picks the program for the host and runs it through `exec.ts`, so the
 * binary still comes from binary.json / `<agentDir>/bin` / known dirs / PATH.
 */

import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { resolveTool } from "./binaries/resolve.ts";
import { quoteForCmd, runTool, runToolSync } from "./exec.ts";
import { tempDir } from "./paths.ts";
import { currentPlatform, type HostPlatform } from "./platform.ts";

export interface OsOptions {
	env?: NodeJS.ProcessEnv;
	host?: HostPlatform;
}

/** Current OS account name; unavailable accounts do not prevent startup. */
export function username(): string | undefined {
	try {
		return (
			userInfo()
				.username.replace(/[\x00-\x1f\x7f-\x9f]/g, "")
				.trim() || undefined
		);
	} catch {
		return undefined;
	}
}

// ── Open a URL or path ──────────────────────────────────────────────────────

export interface OpenOptions extends OsOptions {
	/** Browser/app name or path. Default: the OS default handler. */
	app?: string;
	timeoutMs?: number;
}

/** Program + args that open `target` on `host` (exported for tests). */
export function openCommand(
	target: string,
	host: HostPlatform,
	app?: string,
): { name: string; args: string[]; verbatim?: boolean } {
	if (host.os === "darwin") return { name: "open", args: app ? ["-a", app, target] : [target] };
	if (host.os === "win32") {
		// `start` is a cmd.exe builtin; "" is its window-title argument.
		const parts = ["start", '""', ...(app ? [quoteForCmd(app)] : []), quoteForCmd(target)];
		return { name: "cmd", args: ["/d", "/s", "/c", `"${parts.join(" ")}"`], verbatim: true };
	}
	if (host.wsl && !app) {
		// WSL: hand the target to Windows so the user's default browser opens.
		return { name: "wslview", args: [target] };
	}
	return { name: app ?? "xdg-open", args: [target] };
}

/**
 * Open a URL or file with the OS default handler (or `app`). Throws a
 * BinaryMissingError with an install hint when the opener is missing, or an
 * Error with the opener's stderr when it exits non-zero.
 */
export async function openTarget(target: string, opts: OpenOptions = {}): Promise<void> {
	const host = opts.host ?? currentPlatform();
	let cmd = openCommand(target, host, opts.app);
	if (cmd.name === "wslview" && !resolveTool("wslview", opts))
		cmd = openCommand(target, { ...host, wsl: false });
	const result = await runTool(cmd.name, cmd.args, {
		env: opts.env,
		host,
		timeoutMs: opts.timeoutMs ?? 15_000,
		verbatim: cmd.verbatim,
	});
	if (result.code !== 0)
		throw new Error(result.stderr.trim() || `${cmd.name} exited with code ${result.code}`);
}

// ── Git ─────────────────────────────────────────────────────────────────────────

export interface GitOptions extends OsOptions {
	cwd: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	maxBuffer?: number;
}

/**
 * `git args…` in `cwd`: stdout on exit 0, null on any git failure (not a
 * repo, timeout, abort, or output cut at `maxBuffer`). A missing git binary rejects with BinaryMissingError
 * so the caller can surface the install hint once (pix-pretty warnBinaryMissing).
 */
export async function runGit(args: readonly string[], opts: GitOptions): Promise<string | null> {
	const r = await runTool("git", args, {
		cwd: opts.cwd,
		env: opts.env,
		host: opts.host,
		timeoutMs: opts.timeoutMs ?? 5_000,
		signal: opts.signal,
		maxBuffer: opts.maxBuffer,
	}).catch((err: unknown) => {
		if (err instanceof Error && err.name === "BinaryMissingError") throw err;
		return null;
	});
	return r && r.code === 0 && !r.truncated ? r.stdout : null;
}

// ── Clipboard image ─────────────────────────────────────────────────────────

const LIST_TIMEOUT_MS = 1000;
const READ_TIMEOUT_MS = 3000;
const POWERSHELL_TIMEOUT_MS = 5000;

/** Preference order mirrors Pi: PNG first, then other lossless/animated formats. */
const SUPPORTED_MIME = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export interface ClipboardImage {
	bytes: Buffer;
	mimeType: string;
}

function baseMime(mimeType: string): string {
	return mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
}

export function pickPreferredMime(types: readonly string[]): string | null {
	const normalized = types
		.map((t) => t.trim())
		.filter(Boolean)
		.map((t) => ({ raw: t, base: baseMime(t) }));
	for (const preferred of SUPPORTED_MIME) {
		const match = normalized.find((t) => t.base === preferred);
		if (match) return match.raw;
	}
	return normalized.find((t) => t.base.startsWith("image/"))?.raw ?? null;
}

/** Output bytes when the tool exists and exits 0; null otherwise (probing, never throws). */
function probe(name: string, args: string[], timeoutMs: number, opts: OsOptions): Buffer | null {
	if (!resolveTool(name, opts)) return null;
	try {
		const r = runToolSync(name, args, { env: opts.env, host: opts.host, timeoutMs });
		return r.code === 0 ? r.stdoutBytes : null;
	} catch {
		return null;
	}
}

function lines(buf: Buffer | null): string[] {
	return buf
		? buf
				.toString("utf-8")
				.split(/\r?\n/)
				.map((t) => t.trim())
				.filter(Boolean)
		: [];
}

function viaWlPaste(opts: OsOptions): ClipboardImage | null {
	const selected = pickPreferredMime(
		lines(probe("wl-paste", ["--list-types"], LIST_TIMEOUT_MS, opts)),
	);
	if (!selected) return null;
	const data = probe("wl-paste", ["--type", selected, "--no-newline"], READ_TIMEOUT_MS, opts);
	return data?.length ? { bytes: data, mimeType: baseMime(selected) } : null;
}

function viaXclip(opts: OsOptions): ClipboardImage | null {
	const targets = lines(
		probe("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], LIST_TIMEOUT_MS, opts),
	);
	const preferred = targets.length > 0 ? pickPreferredMime(targets) : null;
	for (const mimeType of preferred ? [preferred, ...SUPPORTED_MIME] : SUPPORTED_MIME) {
		const data = probe(
			"xclip",
			["-selection", "clipboard", "-t", mimeType, "-o"],
			READ_TIMEOUT_MS,
			opts,
		);
		if (data?.length) return { bytes: data, mimeType: baseMime(mimeType) };
	}
	return null;
}

/** Windows clipboard via PowerShell — native Windows, or from WSL via powershell.exe. */
function viaPowerShell(host: HostPlatform, opts: OsOptions): ClipboardImage | null {
	const tmpFile = join(tempDir(), `pix-clip-${randomUUID()}.png`);
	try {
		const winPath =
			host.os === "win32"
				? tmpFile
				: lines(probe("wslpath", ["-w", tmpFile], LIST_TIMEOUT_MS, opts))[0];
		if (!winPath) return null;
		const script = [
			"Add-Type -AssemblyName System.Windows.Forms",
			"Add-Type -AssemblyName System.Drawing",
			`$path = '${winPath.split("'").join("''")}'`,
			"$img = [System.Windows.Forms.Clipboard]::GetImage()",
			"if ($img) { $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'ok' } else { Write-Output 'empty' }",
		].join("; ");
		const args = ["-NoProfile", "-STA", "-Command", script];
		const out = probe("powershell", args, POWERSHELL_TIMEOUT_MS, opts);
		if (out?.toString("utf-8").trim() !== "ok") return null;
		const bytes = readFileSync(tmpFile);
		return bytes.length ? { bytes, mimeType: "image/png" } : null;
	} catch {
		return null;
	} finally {
		try {
			unlinkSync(tmpFile);
		} catch {
			// best-effort cleanup
		}
	}
}

/**
 * Read an image from the system clipboard, or null when there is none (or no
 * clipboard tool). Windows and WSL use PowerShell; Linux uses wl-paste/xclip.
 * macOS and Termux return null (no dependency-free bridge).
 */
export function readClipboardImage(opts: OsOptions = {}): ClipboardImage | null {
	const host = opts.host ?? currentPlatform();
	const env = opts.env ?? process.env;
	if (host.os === "win32") return viaPowerShell(host, opts);
	if (host.os !== "linux") return null;
	const wayland = Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland";
	let image: ClipboardImage | null = null;
	if (wayland || host.wsl) image = viaWlPaste(opts) ?? viaXclip(opts);
	if (!image && host.wsl) image = viaPowerShell(host, opts);
	if (!image && !wayland) image = viaXclip(opts);
	return image;
}

/** {@link readClipboardImage}, spilled to a temp file. Returns the path or null. */
export function readClipboardImageToFile(opts: OsOptions = {}): string | null {
	const image = readClipboardImage(opts);
	if (!image) return null;
	const ext = extForMime(image.mimeType);
	const filePath = join(tempDir(), `pix-clipboard-${randomUUID()}.${ext}`);
	try {
		writeFileSync(filePath, image.bytes);
		return filePath;
	} catch {
		return null;
	}
}

export function extForMime(mimeType: string): string {
	switch (baseMime(mimeType)) {
		case "image/jpeg":
			return "jpg";
		case "image/webp":
			return "webp";
		case "image/gif":
			return "gif";
		default:
			return "png";
	}
}
