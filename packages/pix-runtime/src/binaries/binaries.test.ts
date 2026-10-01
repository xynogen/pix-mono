import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tempDir } from "../paths.ts";
import type { HostPlatform } from "../platform.ts";
import { BINARY_NAMES, type BinarySpec, CATALOG, downloadAsset } from "./catalog.ts";
import { ensureTool, installFromRelease, type ToolStatus } from "./ensure.ts";
import { BinaryMissingError, listTools, lookupTool, requireTool, resolveTool } from "./resolve.ts";
import { binaryFilePath, readBinaryStore, setBinaryChoice, syncBinaryStore } from "./store.ts";

const isWin = process.platform === "win32";
const host: HostPlatform = isWin
	? { os: "win32", arch: "x64", wsl: false, termux: false, exe: ".exe" }
	: { os: "linux", arch: "x64", libc: "glibc", wsl: false, termux: false, exe: "" };

/** Isolated agent dir + PATH; `put` drops a runnable fake executable. */
function sandbox() {
	const root = mkdtempSync(join(tempDir(), "pix-bin-"));
	const agent = join(root, "agent");
	const pathDir = join(root, "path");
	mkdirSync(join(agent, "bin"), { recursive: true });
	mkdirSync(pathDir);
	const env: NodeJS.ProcessEnv = {
		PI_CODING_AGENT_DIR: agent,
		PATH: pathDir,
		PATHEXT: ".EXE;.CMD",
	};
	const put = (dir: string, name: string) => {
		const p = join(dir, `${name}${isWin ? ".exe" : ""}`);
		writeFileSync(p, isWin ? "MZ" : "#!/bin/sh\necho fake\n");
		if (!isWin) chmodSync(p, 0o755);
		return p;
	};
	return { root, agent, bin: join(agent, "bin"), pathDir, env, put };
}

describe("catalog", () => {
	const hosts: HostPlatform[] = [
		{ os: "win32", arch: "x64", wsl: false, termux: false, exe: ".exe" },
		{ os: "linux", arch: "x64", libc: "glibc", wsl: false, termux: false, exe: "" },
		{ os: "linux", arch: "arm64", libc: "glibc", wsl: false, termux: false, exe: "" },
		{ os: "darwin", arch: "arm64", wsl: false, termux: false, exe: "" },
		{ os: "darwin", arch: "x64", wsl: false, termux: false, exe: "" },
	];
	const assetShape = /^[\w.-]+\.(zip|tar\.gz|tar\.xz)$/;

	test("every downloadable asset has an archive name", () => {
		for (const h of hosts)
			for (const name of BINARY_NAMES) {
				const asset = downloadAsset(CATALOG[name] as BinarySpec, h, "1.2.3");
				if (asset) expect(asset).toMatch(assetShape);
			}
	});

	test("download matrix matches the decided policy", () => {
		const dl = (h: HostPlatform) =>
			BINARY_NAMES.filter((n) => downloadAsset(CATALOG[n] as BinarySpec, h) !== undefined).join(
				",",
			);
		expect(dl(hosts[0] as HostPlatform)).toBe("aria2c,ffmpeg,hunk,rtk");
		expect(dl(hosts[1] as HostPlatform)).toBe("ffmpeg,hunk,rtk");
		expect(dl(hosts[3] as HostPlatform)).toBe("hunk,rtk");
		expect(dl({ os: "android", arch: "arm64", wsl: false, termux: true, exe: "" })).toBe("");
	});

	test("every entry has a hint and at least one OS", () => {
		for (const name of BINARY_NAMES) {
			const spec = CATALOG[name] as BinarySpec;
			expect(spec.os.length).toBeGreaterThan(0);
			expect(spec.hint.default ?? Object.values(spec.hint)[0]).toBeTruthy();
		}
	});
});

describe("binary.json", () => {
	test("sync never creates the file", () => {
		const s = sandbox();
		syncBinaryStore(s.env);
		expect(existsSync(binaryFilePath(s.env))).toBe(false);
	});

	test("sync migrates legacy null padding to overrides only", () => {
		const s = sandbox();
		const legacy: Record<string, string | null> = { custom: null };
		for (const name of BINARY_NAMES) legacy[name] = null;
		legacy.rtk = "/opt/rtk";
		writeFileSync(binaryFilePath(s.env), JSON.stringify(legacy));
		syncBinaryStore(s.env);
		const doc = JSON.parse(readFileSync(binaryFilePath(s.env), "utf-8"));
		expect(doc).toEqual({ $version: 1, custom: null, rtk: "/opt/rtk" });
	});

	test("sync keeps user values and unknown keys", () => {
		const s = sandbox();
		writeFileSync(binaryFilePath(s.env), JSON.stringify({ rtk: "/opt/rtk", custom: "/x/custom" }));
		const state = syncBinaryStore(s.env);
		expect(state.choices).toEqual({ rtk: "/opt/rtk", custom: "/x/custom" });
	});

	test("invalid JSON is reported and never overwritten", () => {
		const s = sandbox();
		writeFileSync(binaryFilePath(s.env), "{ nope");
		const state = syncBinaryStore(s.env);
		expect(state.error).toBeTruthy();
		expect(readFileSync(binaryFilePath(s.env), "utf-8")).toBe("{ nope");
	});

	test("setBinaryChoice writes and clears one entry", () => {
		const s = sandbox();
		setBinaryChoice("hunk", "/tools/hunk", s.env);
		expect(readBinaryStore(s.env).choices.hunk).toBe("/tools/hunk");
		setBinaryChoice("hunk", null, s.env);
		expect(JSON.parse(readFileSync(binaryFilePath(s.env), "utf-8"))).toEqual({ $version: 1 });
	});
});

describe("resolve order", () => {
	test("bin/ wins over PATH", () => {
		const s = sandbox();
		const local = s.put(s.bin, "rtk");
		s.put(s.pathDir, "rtk");
		expect(resolveTool("rtk", { env: s.env, host })).toEqual({
			name: "rtk",
			path: local,
			source: "bin",
		});
	});

	test("PATH is used when bin/ lacks it", () => {
		const s = sandbox();
		const onPath = s.put(s.pathDir, "hunk");
		expect(resolveTool("hunk", { env: s.env, host })?.source).toBe("path");
		expect(resolveTool("hunk", { env: s.env, host })?.path).toBe(onPath);
	});

	test("a user path wins, and a missing one is broken (no fallback)", () => {
		const s = sandbox();
		s.put(s.bin, "rtk");
		const mine = s.put(s.root, "rtk");
		setBinaryChoice("rtk", mine, s.env);
		expect(resolveTool("rtk", { env: s.env, host })?.source).toBe("user");
		setBinaryChoice("rtk", join(s.root, "gone", "rtk"), s.env);
		const hit = lookupTool("rtk", { env: s.env, host });
		expect(hit.state).toBe("broken");
		expect(resolveTool("rtk", { env: s.env, host })).toBeUndefined();
	});

	test("an invalid binary.json blocks lookup instead of falling back", () => {
		const s = sandbox();
		s.put(s.pathDir, "hunk");
		writeFileSync(binaryFilePath(s.env), '{ "hunk": "/opt/hunk", }');
		const hit = lookupTool("hunk", { env: s.env, host });
		expect(hit).toMatchObject({
			state: "broken",
			error: expect.stringMatching(/^binary\.json is invalid \(/),
		});
		expect(resolveTool("hunk", { env: s.env, host })).toBeUndefined();
		expect(() => requireTool("hunk", { env: s.env, host })).toThrow(
			/^hunk: binary\.json is invalid \(/,
		);
	});

	test("bash is found in Git for Windows' install dir when not on PATH", () => {
		const s = sandbox();
		const win: HostPlatform = { os: "win32", arch: "x64", wsl: false, termux: false, exe: ".exe" };
		const gitBin = join(s.root, "Program Files", "Git", "bin");
		mkdirSync(gitBin, { recursive: true });
		const bash = join(gitBin, "bash.exe");
		writeFileSync(bash, "MZ");
		if (!isWin) chmodSync(bash, 0o755);
		const env = { ...s.env, ProgramFiles: join(s.root, "Program Files") };
		const hit = lookupTool("bash", { env, host: win });
		expect(hit).toMatchObject({ state: "ok", source: "system" });
		expect(hit.path?.replaceAll("\\", "/")).toMatch(/Program Files\/Git\/bin\/bash\.exe$/);
	});

	// Windows finds powershell.exe by the first name through PATHEXT.
	test.skipIf(isWin)("alternate names (powershell.exe under WSL) resolve", () => {
		const s = sandbox();
		s.put(s.pathDir, "powershell.exe");
		const wsl: HostPlatform = { ...host, os: "linux", exe: "", wsl: true };
		expect(resolveTool("powershell", { env: s.env, host: wsl })?.path).toContain("powershell.exe");
	});

	test("listTools covers catalog + user keys with states", () => {
		const s = sandbox();
		writeFileSync(binaryFilePath(s.env), JSON.stringify({ custom: null }));
		const rows = listTools({ env: s.env, host });
		expect(rows.map((r) => r.name)).toContain("custom");
		const ffmpeg = rows.find((r) => r.name === "ffmpeg");
		expect(ffmpeg?.state).toBe(
			host.os === "linux" || host.os === "win32" ? "missing" : "unsupported",
		);
		expect(rows.find((r) => r.name === "rtk")?.downloadable).toBe(true);
	});

	test("binaries tab: the cursor reaches other-platform rows, which stay read-only", async () => {
		const { createBinariesTab } = await import("../binaries-tab.ts");
		const s = sandbox();
		const tab = createBinariesTab({
			env: s.env,
			theme: { fg: (_c, t) => t, bold: (t) => t },
			requestRender: () => {},
		});
		const body = tab.view(200).body;
		expect(body.some((l) => l.trim() === "Other platforms")).toBe(true);
		tab.handleInput("", { up: true, down: false, enter: false }); // wraps to the last row
		const view = tab.view(200);
		expect(view.selectedBodyLine).toBe(body.length - 1);
		expect(view.header.join("\n")).toMatch(/not used on this OS/);
		// d (automatic) on a read-only row writes nothing.
		tab.handleInput("d", { up: false, down: false, enter: false });
		expect(existsSync(binaryFilePath(s.env))).toBe(false);
	});

	test("a tool for another OS stays unsupported even when the file exists here", () => {
		const s = sandbox();
		s.put(s.pathDir, "open");
		const linux: HostPlatform = { ...host, os: "linux", exe: "", wsl: false };
		expect(lookupTool("open", { env: s.env, host: linux }).state).toBe("unsupported");
	});

	test("binaries tab: / filters by name or user, ↑↓ move, esc clears", async () => {
		const { createBinariesTab } = await import("../binaries-tab.ts");
		const s = sandbox();
		const tab = createBinariesTab({
			env: s.env,
			theme: { fg: (_c, t) => t, bold: (t) => t },
			requestRender: () => {},
		});
		const none = { up: false, down: false, enter: false };
		const rowNames = () =>
			tab
				.view(200)
				.body.map((l) => l.trim().replace(/^→\s*/, "").split(/\s+/)[1])
				.filter((n): n is string => Boolean(n) && n !== "platforms");
		const all = rowNames().length;
		tab.handleInput("/", none);
		expect(tab.editing).toBe(true);
		for (const ch of "ssh") tab.handleInput(ch, none);
		expect(rowNames()).toEqual(expect.arrayContaining(["ssh", "scp", "sshpass"]));
		expect(rowNames().length).toBeLessThan(all);
		expect(tab.view(200).header.join("\n")).toMatch(/filter: ssh/);
		tab.handleInput("", { ...none, down: true });
		expect(tab.view(200).body[1]).toMatch(/^→ /);
		tab.handleInput("\r", none); // enter keeps the filter and closes the input
		expect(tab.editing).toBe(false);
		expect(tab.view(200).header.join("\n")).toMatch(/filter: ssh · \d+ of \d+/);
		expect(tab.clearFilter()).toBe(true);
		expect(rowNames().length).toBe(all);
	});

	test("WSL-only tools are needed on WSL, not on plain Linux", () => {
		const s = sandbox();
		const linux: HostPlatform = { ...host, os: "linux", exe: "", wsl: false };
		for (const name of ["wslpath", "wslview", "powershell"]) {
			expect(lookupTool(name, { env: s.env, host: linux }).state).toBe("unsupported");
			expect(lookupTool(name, { env: s.env, host: { ...linux, wsl: true } }).state).toBe("missing");
		}
	});
});

// ── Downloader (fake GitHub; real system tar) ────────────────────────────────

function makeArchive(dir: string, exe: string): { file: string; bytes: Buffer } {
	const stage = join(dir, "stage", "pkg-dir");
	mkdirSync(stage, { recursive: true });
	writeFileSync(join(stage, exe), isWin ? "MZfake" : "#!/bin/sh\necho 9.9.9\n");
	const file = join(dir, "asset.tar.gz");
	const tar = isWin ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
	const r = spawnSync(tar, ["czf", file, "-C", join(dir, "stage"), "pkg-dir"]);
	if (r.status !== 0) throw new Error(`tar failed: ${r.stderr}`);
	return { file, bytes: readFileSync(file) };
}

function fakeGithub(asset: string, bytes: Buffer, checksum: string | null | "404") {
	const calls: string[] = [];
	const fn = (async (input: string | URL | Request) => {
		const url = String(input);
		calls.push(url);
		if (url.endsWith("/releases/latest"))
			return new Response(null, {
				status: 302,
				headers: { location: "https://github.com/o/r/releases/tag/v9.9.9" },
			});
		if (url.endsWith(`/${asset}`)) return new Response(new Uint8Array(bytes));
		if (url.endsWith("/SUMS")) {
			if (checksum === "404") return new Response("", { status: 404 });
			return new Response(`${checksum}  ${asset}\n${"0".repeat(64)}  other.tar.gz\n`);
		}
		return new Response("", { status: 404 });
	}) as typeof fetch;
	return { fn, calls };
}

const recipeSpec = (asset: string, checksums?: string): BinarySpec => ({
	usedBy: ["test"],
	os: ["win32", "linux", "darwin"],
	hint: { default: "install fake" },
	download: { repo: "o/r", checksums, asset: () => asset },
});

describe("installFromRelease", () => {
	const exe = `faketool${host.exe}`;

	test("downloads, verifies the checksum, extracts into bin/ and cleans up", async () => {
		const s = sandbox();
		const { bytes } = makeArchive(s.root, exe);
		const sha = createHash("sha256").update(bytes).digest("hex");
		const gh = fakeGithub("faketool.tar.gz", bytes, sha);
		const statuses: ToolStatus[] = [];
		const got = await installFromRelease("faketool", recipeSpec("faketool.tar.gz", "SUMS"), host, {
			env: s.env,
			fetch: gh.fn,
			onStatus: (st) => statuses.push(st),
		});
		expect(got).toMatchObject({ source: "download", version: "9.9.9", path: join(s.bin, exe) });
		expect(existsSync(join(s.bin, exe))).toBe(true);
		expect(statuses.map((x) => x.kind)).toEqual(["downloading", "installed"]);
		expect(statuses[1]).toMatchObject({ verified: true });
		expect(gh.calls[1]).toBe("https://github.com/o/r/releases/download/v9.9.9/faketool.tar.gz");
		expect(readdirSync(s.bin).filter((f) => f.startsWith(".pix-dl-"))).toEqual([]);
	});

	test("checksum mismatch fails and installs nothing", async () => {
		const s = sandbox();
		const { bytes } = makeArchive(s.root, exe);
		const gh = fakeGithub("faketool.tar.gz", bytes, "f".repeat(64));
		const statuses: ToolStatus[] = [];
		const run = installFromRelease("faketool", recipeSpec("faketool.tar.gz", "SUMS"), host, {
			env: s.env,
			fetch: gh.fn,
			onStatus: (st) => statuses.push(st),
		});
		await expect(run).rejects.toBeInstanceOf(BinaryMissingError);
		expect(existsSync(join(s.bin, exe))).toBe(false);
		expect(statuses.at(-1)).toMatchObject({ kind: "failed" });
		expect(readdirSync(s.bin)).toEqual([]);
	});

	test("a declared manifest that is missing fails and installs nothing", async () => {
		const s = sandbox();
		const { bytes } = makeArchive(s.root, exe);
		const gh = fakeGithub("faketool.tar.gz", bytes, "404");
		const statuses: ToolStatus[] = [];
		const run = installFromRelease("faketool", recipeSpec("faketool.tar.gz", "SUMS"), host, {
			env: s.env,
			fetch: gh.fn,
			onStatus: (st) => statuses.push(st),
		});
		await expect(run).rejects.toBeInstanceOf(BinaryMissingError);
		expect(existsSync(join(s.bin, exe))).toBe(false);
		expect(statuses.at(-1)).toMatchObject({
			kind: "failed",
			error: expect.stringMatching(/^checksum manifest missing/),
		});
	});

	test("a recipe without a manifest installs unverified", async () => {
		const s = sandbox();
		const { bytes } = makeArchive(s.root, exe);
		const gh = fakeGithub("faketool.tar.gz", bytes, null);
		const statuses: ToolStatus[] = [];
		await installFromRelease("faketool", recipeSpec("faketool.tar.gz"), host, {
			env: s.env,
			fetch: gh.fn,
			onStatus: (st) => statuses.push(st),
		});
		expect(statuses.at(-1)).toMatchObject({ kind: "installed", verified: false });
	});
});

describe("ensureTool", () => {
	test("returns an existing binary without network", async () => {
		const s = sandbox();
		const local = s.put(s.bin, "hunk");
		const got = await ensureTool("hunk", {
			env: s.env,
			host,
			fetch: (() => {
				throw new Error("no network expected");
			}) as unknown as typeof fetch,
		});
		expect(got.path).toBe(local);
	});

	test("PI_OFFLINE skips the download with the hint", async () => {
		const s = sandbox();
		await expect(ensureTool("rtk", { env: { ...s.env, PI_OFFLINE: "1" }, host })).rejects.toThrow(
			/PI_OFFLINE/,
		);
	});

	test("check-only entries throw the install hint", async () => {
		const s = sandbox();
		await expect(
			ensureTool("sshpass", { env: s.env, host: { ...host, os: "linux", exe: "" } }),
		).rejects.toThrow(/install: install sshpass/);
	});
});

describe("middleTruncate", () => {
	test("keeps both ends of a long path within the width", async () => {
		const { middleTruncate } = await import("../binaries-tab.ts");
		const p = String.raw`C:\Program Files\Git\bin\bash.exe`;
		expect(middleTruncate(p, 60)).toBe(p);
		const short = middleTruncate(p, 20);
		expect(short.length).toBe(20);
		expect(short).toMatch(/^C:\\Prog[^…]*…[^…]*\\bash\.exe$/);
	});
});
