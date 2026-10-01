/**
 * catalog.ts — every external command a pix package runs.
 *
 * One entry per executable: who uses it, where it matters, how to get it, and
 * (for a few) a trusted GitHub release pix may download into `<agentDir>/bin`.
 * User-defined commands (LSP servers, proc commands, skill scripts) are not
 * catalogued; `which.ts` keeps serving those.
 */

import { join } from "node:path";
import type { HostOs, HostPlatform } from "../platform.ts";

export interface DownloadRecipe {
	/** GitHub `owner/repo`. The latest release is found via the `/releases/latest` redirect. */
	repo: string;
	/** Release asset for this host and version (tag minus `v`/`release-`), or undefined if none. */
	asset(host: HostPlatform, version: string): string | undefined;
	/** Checksum manifest asset (`<sha256>  <name>` lines). Verified when set. */
	checksums?: string;
	/** Rough archive size shown before download. */
	size?: string;
}

export interface BinarySpec {
	/** Packages that run it. */
	usedBy: readonly string[];
	/** OSes where it is used. */
	os: readonly HostOs[];
	/** On Linux, used only under WSL (Windows interop). */
	wslOnly?: boolean;
	/** Alternative executable names tried in order (defaults to the key). */
	names?: readonly string[];
	/** Install hint per OS; `default` otherwise. */
	hint: Partial<Record<HostOs | "default", string>>;
	/** Nice-to-have: absence is informational, not an error. */
	optional?: boolean;
	/**
	 * Standard install locations checked after `<agentDir>/bin` and before PATH
	 * (e.g. Git Bash, which Git for Windows keeps off PATH). Empty values skipped.
	 */
	knownPaths?(env: NodeJS.ProcessEnv, host: HostPlatform): readonly string[];
	/** Args printing a version, or null when the tool has no safe version probe. */
	versionArgs?: readonly string[] | null;
	download?: DownloadRecipe;
}

const ALL: readonly HostOs[] = ["win32", "linux", "darwin", "android"];
const UNIX: readonly HostOs[] = ["linux", "darwin", "android"];
const LINUX: readonly HostOs[] = ["linux"];

/** Env lookup ignoring case: a copied Windows env loses process.env's case-insensitivity. */
function envVar(env: NodeJS.ProcessEnv, key: string): string | undefined {
	if (env[key]) return env[key];
	const k = Object.keys(env).find((x) => x.toLowerCase() === key.toLowerCase());
	return k ? env[k] : undefined;
}

const rustTriple = (h: HostPlatform): string | undefined => {
	if (h.os === "win32") return "x86_64-pc-windows-msvc"; // x64 build also runs on Windows arm64
	if (h.os === "darwin") return `${h.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`;
	if (h.os !== "linux") return undefined;
	if (h.arch === "x64") return "x86_64-unknown-linux-musl";
	return h.libc === "glibc" ? "aarch64-unknown-linux-gnu" : undefined;
};

export const CATALOG = {
	rtk: {
		usedBy: ["pix-optimizer"],
		os: ALL,
		hint: {
			win32: "winget install rtk-ai.rtk",
			default: "download from github.com/rtk-ai/rtk/releases or `cargo install rtk`",
		},
		download: {
			repo: "rtk-ai/rtk",
			checksums: "checksums.txt",
			size: "~5 MB",
			asset: (h) => {
				const t = rustTriple(h);
				if (!t) return undefined;
				return `rtk-${t}.${h.os === "win32" ? "zip" : "tar.gz"}`;
			},
		},
	},
	hunk: {
		usedBy: ["pix-hunk"],
		os: ALL,
		hint: { default: "npm install -g hunkdiff" },
		download: {
			repo: "modem-dev/hunk",
			checksums: "SHA256SUMS",
			size: "~40 MB",
			asset: (h) => {
				if (h.os === "win32") return "hunkdiff-windows-x64.tar.gz";
				if (h.os === "linux" || h.os === "darwin") return `hunkdiff-${h.os}-${h.arch}.tar.gz`;
				return undefined;
			},
		},
	},
	aria2c: {
		usedBy: ["pix-aria2"],
		os: ALL,
		hint: {
			linux: "apt install aria2 · dnf install aria2 · pacman -S aria2",
			darwin: "brew install aria2",
			android: "pkg install aria2",
			win32: "winget install aria2.aria2",
			default: "download from github.com/aria2/aria2/releases",
		},
		download: {
			repo: "aria2/aria2",
			size: "~2.4 MB",
			asset: (h, v) => (h.os === "win32" ? `aria2-${v}-win-64bit-build1.zip` : undefined),
		},
	},
	ffmpeg: {
		usedBy: ["pix-voice"],
		os: ["linux", "win32", "darwin"],
		versionArgs: ["-version"],
		hint: {
			linux: "apt install ffmpeg · dnf install ffmpeg · pacman -S ffmpeg",
			darwin: "brew install ffmpeg",
			win32: "winget install Gyan.FFmpeg",
			default: "install ffmpeg",
		},
		download: {
			repo: "BtbN/FFmpeg-Builds",
			checksums: "checksums.sha256",
			size: "~120 MB",
			asset: (h) => {
				const arm = h.arch === "arm64";
				if (h.os === "win32") return `ffmpeg-master-latest-${arm ? "winarm64" : "win64"}-lgpl.zip`;
				if (h.os === "linux")
					return `ffmpeg-master-latest-${arm ? "linuxarm64" : "linux64"}-lgpl.tar.xz`;
				return undefined;
			},
		},
	},
	rg: {
		usedBy: ["pix-search", "pix-grep", "pix-graph"],
		os: ALL,
		hint: {
			android: "pkg install ripgrep",
			win32: "restart Pi (it downloads rg) or winget install BurntSushi.ripgrep.MSVC",
			default: "restart Pi (it downloads rg) or install ripgrep",
		},
	},
	git: {
		usedBy: ["pix-footer", "pix-welcome", "pix-subagent", "pix-search"],
		os: ALL,
		hint: {
			win32: "winget install Git.Git",
			darwin: "xcode-select --install",
			default: "install git",
		},
	},
	ssh: {
		usedBy: ["pix-ssh"],
		os: ALL,
		versionArgs: ["-V"],
		hint: {
			win32:
				"enable the OpenSSH Client optional feature or winget install Microsoft.OpenSSH.Preview",
			default: "install openssh-client",
		},
	},
	scp: {
		usedBy: ["pix-ssh"],
		os: ALL,
		versionArgs: null,
		hint: {
			win32:
				"enable the OpenSSH Client optional feature or winget install Microsoft.OpenSSH.Preview",
			default: "install openssh-client",
		},
	},
	sshpass: {
		usedBy: ["pix-ssh"],
		os: UNIX,
		versionArgs: ["-V"],
		hint: { darwin: "brew install sshpass", default: "install sshpass" },
	},
	sudo: { usedBy: ["pix-sudo"], os: UNIX, hint: { default: "install sudo" } },
	"wl-paste": { usedBy: ["pix-ask"], os: LINUX, hint: { default: "install wl-clipboard" } },
	xclip: {
		usedBy: ["pix-ask"],
		os: LINUX,
		versionArgs: ["-version"],
		hint: { default: "install xclip" },
	},
	wslpath: {
		usedBy: ["pix-ask"],
		os: LINUX,
		wslOnly: true,
		versionArgs: null,
		hint: { default: "WSL only" },
	},
	open: {
		usedBy: ["pix-mcp"],
		os: ["darwin"],
		versionArgs: null,
		hint: { default: "built into macOS" },
	},
	"xdg-open": { usedBy: ["pix-mcp"], os: LINUX, hint: { default: "install xdg-utils" } },
	cmd: {
		usedBy: ["pix-mcp"],
		os: ["win32"],
		versionArgs: null,
		knownPaths: (env) => [`${envVar(env, "SystemRoot") ?? "C:\\Windows"}\\System32\\cmd.exe`],
		hint: { default: "built into Windows" },
	},
	npm: {
		usedBy: ["pix-mcp"],
		os: ALL,
		hint: { win32: "winget install OpenJS.NodeJS.LTS", default: "install Node.js" },
	},
	npx: {
		usedBy: ["pix-mcp"],
		os: ALL,
		hint: { win32: "winget install OpenJS.NodeJS.LTS", default: "install Node.js" },
	},
	pi: {
		usedBy: ["pix-update", "pix-models", "pix-welcome"],
		os: ALL,
		hint: { default: "npm install -g @earendil-works/pi-coding-agent" },
	},
	powershell: {
		usedBy: ["pix-powershell", "pix-ask", "pix-voice"],
		os: ["win32", "linux"],
		wslOnly: true,
		// WSL reaches Windows PowerShell through interop as powershell.exe.
		names: ["powershell", "powershell.exe"],
		versionArgs: null,
		hint: { linux: "WSL only (Windows interop)", default: "built into Windows" },
	},
	wslview: {
		usedBy: ["pix-mcp"],
		os: LINUX,
		wslOnly: true,
		optional: true,
		versionArgs: null,
		hint: { default: "WSL only: install wslu" },
	},
	bash: {
		usedBy: ["pix-bash", "pix-mcp"],
		os: ALL,
		hint: { win32: "winget install Git.Git (Git Bash)", default: "install bash" },
		// Same locations Pi searches: Git for Windows puts only Git\cmd on PATH.
		knownPaths: (env, h) =>
			h.os === "win32"
				? [envVar(env, "ProgramFiles"), envVar(env, "ProgramFiles(x86)")]
						.filter((d): d is string => !!d)
						// Native join: backslashes on real Windows, and the fake-win32 test runs anywhere.
						.map((d) => join(d, "Git", "bin", "bash.exe"))
				: [],
	},
} satisfies Record<string, BinarySpec>;

export type BinaryName = keyof typeof CATALOG;

export const BINARY_NAMES = Object.keys(CATALOG).sort() as BinaryName[];

export function specOf(name: string): BinarySpec | undefined {
	return (CATALOG as Record<string, BinarySpec>)[name];
}

export function hintFor(spec: BinarySpec, host: HostPlatform): string {
	return spec.hint[host.os] ?? spec.hint.default ?? "";
}

/** Release asset pix would download on this host, or undefined when it only checks. */
export function downloadAsset(
	spec: BinarySpec,
	host: HostPlatform,
	version = "0",
): string | undefined {
	if (!spec.download || host.termux) return undefined;
	return spec.download.asset(host, version);
}
