/**
 * clipboard-image.ts — read an image off the system clipboard and spill it to a
 * temp file, returning the path.
 *
 * The questionnaire runs as an overlay, so Pi's app-level "paste image" handler
 * (Ctrl+V) never reaches it, and Pi's own `readClipboardImage` is not importable
 * (its package exports map exposes only `.` and `./rpc-entry`). This is a small,
 * provider-neutral reimplementation of the same probe order Pi uses:
 *
 *   Wayland / WSL → wl-paste, then xclip
 *   WSL (fallback) → powershell.exe (Windows clipboard)
 *   X11           → xclip
 *
 * Only the reachable, dependency-free path is implemented — spawning the same
 * CLI tools Pi relies on. No clipboard, no image → null (caller falls back to
 * text paste).
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LIST_TIMEOUT_MS = 1000;
const READ_TIMEOUT_MS = 3000;
const POWERSHELL_TIMEOUT_MS = 5000;
const MAX_BUFFER_BYTES = 50 * 1024 * 1024;

// Preference order mirrors Pi: PNG first, then other lossless/animated formats.
const SUPPORTED_MIME = ["image/png", "image/jpeg", "image/webp", "image/gif"];

type ClipImage = { bytes: Buffer; mimeType: string };

function baseMime(mimeType: string): string {
	return mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
}

export function extForMime(mimeType: string): string {
	switch (baseMime(mimeType)) {
		case "image/png":
			return "png";
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

function pickPreferredMime(types: string[]): string | null {
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

function run(command: string, args: string[], timeoutMs = READ_TIMEOUT_MS): Buffer | null {
	const result = spawnSync(command, args, { timeout: timeoutMs, maxBuffer: MAX_BUFFER_BYTES });
	if (result.error || result.status !== 0) return null;
	const out = result.stdout;
	return Buffer.isBuffer(out) ? out : Buffer.from(out ?? "");
}

export function isWaylandSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland";
}

function isWSL(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.WSL_DISTRO_NAME || env.WSLENV) return true;
	try {
		return /microsoft|wsl/i.test(readFileSync("/proc/version", "utf-8"));
	} catch {
		return false;
	}
}

function readViaWlPaste(): ClipImage | null {
	const list = run("wl-paste", ["--list-types"], LIST_TIMEOUT_MS);
	if (!list) return null;
	const types = list
		.toString("utf-8")
		.split(/\r?\n/)
		.map((t) => t.trim())
		.filter(Boolean);
	const selected = pickPreferredMime(types);
	if (!selected) return null;
	const data = run("wl-paste", ["--type", selected, "--no-newline"]);
	if (!data || data.length === 0) return null;
	return { bytes: data, mimeType: baseMime(selected) };
}

function readViaXclip(): ClipImage | null {
	const targets = run("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], LIST_TIMEOUT_MS);
	const candidates = targets
		? targets
				.toString("utf-8")
				.split(/\r?\n/)
				.map((t) => t.trim())
				.filter(Boolean)
		: [];
	const preferred = candidates.length > 0 ? pickPreferredMime(candidates) : null;
	const tryTypes = preferred ? [preferred, ...SUPPORTED_MIME] : [...SUPPORTED_MIME];
	for (const mimeType of tryTypes) {
		const data = run("xclip", ["-selection", "clipboard", "-t", mimeType, "-o"]);
		if (data && data.length > 0) return { bytes: data, mimeType: baseMime(mimeType) };
	}
	return null;
}

function readViaPowerShell(): ClipImage | null {
	const tmpFile = join(tmpdir(), `pix-wsl-clip-${randomUUID()}.png`);
	try {
		const winPathBuf = run("wslpath", ["-w", tmpFile], LIST_TIMEOUT_MS);
		const winPath = winPathBuf?.toString("utf-8").trim();
		if (!winPath) return null;
		const psQuoted = winPath.split("'").join("''");
		const psScript = [
			"Add-Type -AssemblyName System.Windows.Forms",
			"Add-Type -AssemblyName System.Drawing",
			`$path = '${psQuoted}'`,
			"$img = [System.Windows.Forms.Clipboard]::GetImage()",
			"if ($img) { $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'ok' } else { Write-Output 'empty' }",
		].join("; ");
		const out = run("powershell.exe", ["-NoProfile", "-Command", psScript], POWERSHELL_TIMEOUT_MS);
		if (out?.toString("utf-8").trim() !== "ok") return null;
		const bytes = readFileSync(tmpFile);
		if (bytes.length === 0) return null;
		return { bytes, mimeType: "image/png" };
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
 * Read a clipboard image and spill it to a temp file. Returns the file path, or
 * null when there is no image (or no clipboard tool). Linux-only probing; other
 * platforms return null (overlay can't reach a native clipboard bridge).
 */
export function readClipboardImageToFile(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string | null {
	if (env.TERMUX_VERSION || platform !== "linux") return null;

	const wsl = isWSL(env);
	const wayland = isWaylandSession(env);

	let image: ClipImage | null = null;
	if (wayland || wsl) image = readViaWlPaste() ?? readViaXclip();
	if (!image && wsl) image = readViaPowerShell();
	if (!image && !wayland) image = readViaXclip();
	if (!image) return null;

	const ext = extForMime(image.mimeType);
	const filePath = join(tmpdir(), `pix-clipboard-${randomUUID()}.${ext}`);
	try {
		writeFileSync(filePath, image.bytes);
	} catch {
		return null;
	}
	return filePath;
}
