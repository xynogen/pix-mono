/**
 * clipboard-image.ts — read an image off the system clipboard and spill it to a
 * temp file, returning the path.
 *
 * The questionnaire runs as an overlay, so Pi's app-level "paste image" handler
 * (Ctrl+V) never reaches it, and Pi's own `readClipboardImage` is not importable.
 * pix-runtime's `os` layer owns the per-OS probing (Windows/WSL → PowerShell,
 * Wayland → wl-paste, X11 → xclip) and resolves each tool through binary.json.
 * No clipboard, no image → null (caller falls back to text paste).
 */

import { extForMime, readClipboardImageToFile as readViaRuntime } from "@xynogen/pix-runtime/os";
import { currentPlatform, type HostPlatform } from "@xynogen/pix-runtime/platform";

export { extForMime };

export function isWaylandSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland";
}

function hostFor(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): HostPlatform {
	const host = currentPlatform();
	if (env.TERMUX_VERSION) return { ...host, os: "android", termux: true };
	if (platform === host.os) return host;
	if (platform === "win32" || platform === "darwin" || platform === "linux")
		return { ...host, os: platform, wsl: false };
	return { ...host, os: "android" };
}

/**
 * Read a clipboard image and spill it to a temp file. Returns the file path, or
 * null when there is no image (or no clipboard tool). Supported on Windows,
 * WSL, and Linux (Wayland/X11); macOS and Termux return null.
 */
export function readClipboardImageToFile(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = currentPlatform().os,
): string | null {
	return readViaRuntime({ env, host: hostFor(platform, env) });
}
