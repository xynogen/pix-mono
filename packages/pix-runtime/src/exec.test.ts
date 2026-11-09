import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BinaryMissingError } from "./binaries/resolve.ts";
import { setBinaryChoice } from "./binaries/store.ts";
import { commandLine, quoteForCmd, runTool, runToolSync, spawnTool } from "./exec.ts";
import { openCommand } from "./os.ts";
import { tempDir } from "./paths.ts";
import type { HostPlatform } from "./platform.ts";

const isWin = process.platform === "win32";
const win: HostPlatform = { os: "win32", arch: "x64", wsl: false, termux: false, exe: ".exe" };
const linux: HostPlatform = {
	os: "linux",
	arch: "x64",
	libc: "glibc",
	wsl: false,
	termux: false,
	exe: "",
};

/** Isolated agent dir + a PATH dir holding one script that echoes its args. */
function sandbox() {
	const root = mkdtempSync(join(tempDir(), "pix-exec-"));
	const agent = join(root, "agent");
	const pathDir = join(root, "path dir");
	mkdirSync(join(agent, "bin"), { recursive: true });
	mkdirSync(pathDir);
	const sysRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
	const env: NodeJS.ProcessEnv = {
		PI_CODING_AGENT_DIR: agent,
		PATH: isWin ? `${pathDir};${join(sysRoot, "System32")}` : `${pathDir}:/usr/bin:/bin`,
		PATHEXT: ".EXE;.CMD;.BAT",
		SystemRoot: sysRoot,
		PI_OFFLINE: "1",
	};
	return { root, agent, pathDir, env };
}

/**
 * A tool that prints each argument on its own line. On Windows it is an
 * npm-style shim (`.cmd` forwarding `%*` to a JS entry), the real-world case.
 */
function echoTool(dir: string, name: string): string {
	if (isWin) {
		const js = join(dir, `${name}.js`);
		writeFileSync(js, "for (const a of process.argv.slice(2)) console.log(a);\n");
		const p = join(dir, `${name}.cmd`);
		writeFileSync(p, `@"${process.execPath}" "%~dp0\\${name}.js" %*\r\n`);
		return p;
	}
	const p = join(dir, name);
	writeFileSync(p, '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\n');
	chmodSync(p, 0o755);
	return p;
}

describe("commandLine", () => {
	test("real executables pass through unchanged on every OS", () => {
		expect(commandLine("/usr/bin/git", ["log", "a b"], linux)).toEqual({
			command: "/usr/bin/git",
			args: ["log", "a b"],
		});
		expect(commandLine("C:\\Git\\bin\\git.exe", ["a b"], win)).toEqual({
			command: "C:\\Git\\bin\\git.exe",
			args: ["a b"],
		});
	});

	test("Windows batch shims run as one verbatim cmd.exe /d /s /c line", () => {
		const line = commandLine("C:\\node\\npm.cmd", ["root", "-g"], win, {
			SystemRoot: "C:\\Windows",
		});
		expect(line.command).toMatch(/cmd\.exe$/i);
		expect(line.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
		expect(line.args[3]).toMatch(/^"C:\\node\\npm\.cmd \^"root\^" \^"-g\^""$/);
		expect(line.windowsVerbatimArguments).toBe(true);
	});

	test("cmd metacharacters are caret-escaped inside quotes", () => {
		expect(quoteForCmd("a&b|c")).toBe('^"a^&b^|c^"');
		expect(quoteForCmd('say "hi"')).toMatch(/^\^".*\\\^"hi\\\^"\^"$/);
	});
});

describe("runTool / runToolSync", () => {
	test("runs the binary.json choice, not PATH, and reports where it came from", async () => {
		const s = sandbox();
		echoTool(s.pathDir, "pixecho");
		const mineDir = join(s.root, "mine");
		mkdirSync(mineDir);
		const mine = echoTool(mineDir, "pixecho");
		setBinaryChoice("pixecho", mine, s.env);
		const r = await runTool("pixecho", ["one"], { env: s.env });
		expect(r.code).toBe(0);
		expect(r.tool).toMatchObject({ source: "user", path: mine });
	});

	test("arguments with spaces, quotes and cmd metacharacters survive intact", async () => {
		const s = sandbox();
		echoTool(s.pathDir, "pixecho");
		const args = ["plain", "two words", "a&b|c", "100%", "(paren)", 'say "hi"', "^caret"];
		const r = await runTool("pixecho", args, { env: s.env });
		expect(r.code).toBe(0);
		expect(r.stdout.split(/\r?\n/).filter(Boolean)).toEqual(args);
		const sync = runToolSync("pixecho", args, { env: s.env });
		expect(sync.stdout.split(/\r?\n/).filter(Boolean)).toEqual(args);
	});

	test("a child that never reads stdin does not crash the host with EPIPE", async () => {
		const s = sandbox();
		const name = "pixnoread";
		if (isWin) writeFileSync(join(s.pathDir, `${name}.cmd`), "@exit /b 0\r\n");
		else {
			writeFileSync(join(s.pathDir, name), "#!/bin/sh\nexit 0\n");
			chmodSync(join(s.pathDir, name), 0o755);
		}
		// 8 MiB is far past any pipe buffer, so the write outlives the child.
		const r = await runTool(name, [], { env: s.env, input: Buffer.alloc(8 << 20) });
		expect(r.code).toBe(0);
	});

	test("output past maxBuffer is flagged truncated", async () => {
		const s = sandbox();
		echoTool(s.pathDir, "pixecho");
		const r = await runTool("pixecho", ["abcdefgh"], { env: s.env, maxBuffer: 3 });
		expect(r).toMatchObject({ stdout: "abc", truncated: true });
		const full = await runTool("pixecho", ["ab"], { env: s.env });
		expect(full.truncated).toBe(false);
	});

	test.skipIf(isWin)("output past maxBuffer stops a runaway child", async () => {
		const s = sandbox();
		const name = "pixflood";
		writeFileSync(join(s.pathDir, name), "#!/bin/sh\nexec yes\n");
		chmodSync(join(s.pathDir, name), 0o755);
		const started = Date.now();
		const r = await runTool(name, [], { env: s.env, maxBuffer: 1024 });
		expect(r).toMatchObject({ truncated: true, timedOut: false });
		expect(r.stdout.length).toBe(1024);
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	test.skipIf(isWin)("a timeout stops descendants that hold stdout open", async () => {
		const s = sandbox();
		const name = "pixforker";
		// The child ignores SIGTERM and its descendant keeps stdout open.
		writeFileSync(join(s.pathDir, name), "#!/bin/sh\ntrap '' TERM\nsleep 30 &\nwait\n");
		chmodSync(join(s.pathDir, name), 0o755);
		const started = Date.now();
		const r = await runTool(name, [], { env: s.env, timeoutMs: 100 });
		expect(r.timedOut).toBe(true);
		// timeout + SIGTERM-to-SIGKILL grace, with margin for a slow CI host.
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	test("a missing tool is a BinaryMissingError with the catalog hint", async () => {
		const s = sandbox();
		await expect(runTool("sshpass-nope", [], { env: s.env })).rejects.toBeInstanceOf(
			BinaryMissingError,
		);
		expect(() => runToolSync("hunk", [], { env: s.env })).toThrow(/hunk not found — install: /);
		expect(() => spawnTool("hunk", [], { env: s.env })).toThrow(BinaryMissingError);
	});

	test("timeouts kill the child and flag timedOut", async () => {
		const s = sandbox();
		const name = "pixsleep";
		if (isWin) writeFileSync(join(s.pathDir, `${name}.cmd`), "@ping -n 30 127.0.0.1 >nul\r\n");
		else {
			writeFileSync(join(s.pathDir, name), "#!/bin/sh\nexec sleep 30\n");
			chmodSync(join(s.pathDir, name), 0o755);
		}
		const started = Date.now();
		const r = await runTool(name, [], { env: s.env, timeoutMs: 300 });
		expect(r.timedOut).toBe(true);
		expect(r.code).toBeNull();
		expect(Date.now() - started).toBeLessThan(10_000);
	});
});

describe("openCommand", () => {
	test("picks the opener per OS", () => {
		expect(openCommand("https://x.dev", { ...linux, os: "darwin" })).toEqual({
			name: "open",
			args: ["https://x.dev"],
		});
		expect(openCommand("https://x.dev", linux)).toEqual({
			name: "xdg-open",
			args: ["https://x.dev"],
		});
		expect(openCommand("https://x.dev", { ...linux, wsl: true })).toMatchObject({
			name: "wslview",
			cwd: "/",
		});
		const w = openCommand("https://x.dev/?a=1&b=2", win);
		expect(w).toMatchObject({ name: "cmd", verbatim: true });
		expect(w.args[3]).toMatch(/^"start "" \^"https:\/\/x\.dev\/\^\?a=1\^&b=2\^""$/);
	});
});

test("pre-cancelled execution never resolves or starts a binary", async () => {
	await expect(
		runTool("missing-cancelled-tool", [], { signal: AbortSignal.abort(new Error("stopped")) }),
	).rejects.toThrow("stopped");
});

test.skipIf(isWin)("abort stops a SIGTERM-resistant process tree before rejecting", async () => {
	const s = sandbox();
	const name = "pixcancel";
	writeFileSync(join(s.pathDir, name), "#!/bin/sh\ntrap '' TERM\nsleep 30 &\nwait\n");
	chmodSync(join(s.pathDir, name), 0o755);
	const controller = new AbortController();
	const pending = runTool(name, [], { env: s.env, signal: controller.signal });
	const timer = setTimeout(() => controller.abort(new Error("user cancelled")), 100);
	try {
		await expect(pending).rejects.toThrow("user cancelled");
	} finally {
		clearTimeout(timer);
	}
});
