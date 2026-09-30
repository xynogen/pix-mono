import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
	agentDir,
	binDir,
	cacheDir,
	expandHome,
	homeDir,
	moduleFile,
	projectDir,
	tempDir,
} from "./paths.ts";

const HOME_KEY = process.platform === "win32" ? "USERPROFILE" : "HOME";
const home = join("/", "home", "me");

describe("paths", () => {
	test("homeDir reads the platform home variable, else os.homedir()", () => {
		expect(homeDir({ [HOME_KEY]: home })).toBe(home);
		expect(homeDir({})).toBe(homedir());
	});

	test("agentDir honours PI_CODING_AGENT_DIR with tilde expansion", () => {
		expect(agentDir({ [HOME_KEY]: home })).toBe(join(home, ".pi", "agent"));
		expect(agentDir({ [HOME_KEY]: home, PI_CODING_AGENT_DIR: "~/alt" })).toBe(join(home, "alt"));
		const abs = join("/", "opt", "pi");
		expect(agentDir({ PI_CODING_AGENT_DIR: abs })).toBe(abs);
	});

	test("binDir is agentDir/bin", () => {
		expect(binDir({ PI_CODING_AGENT_DIR: join("/", "a") })).toBe(join("/", "a", "bin"));
	});

	test("cacheDir prefers XDG_CACHE_HOME", () => {
		expect(cacheDir({ [HOME_KEY]: home })).toBe(join(home, ".cache", "pi"));
		expect(cacheDir({ XDG_CACHE_HOME: join("/", "xdg") })).toBe(join("/", "xdg", "pi"));
	});

	test("projectDir is <cwd>/.pi, relative .pi without cwd", () => {
		expect(projectDir(join("/", "repo"))).toBe(join("/", "repo", ".pi"));
		expect(projectDir()).toBe(".pi");
	});

	test("tempDir reads the platform temp variable, else os.tmpdir()", () => {
		const t = join("/", "t");
		expect(tempDir({ TMPDIR: t }, "linux")).toBe(t);
		expect(tempDir({ TMPDIR: t }, "darwin")).toBe(t);
		expect(tempDir({ TEMP: t }, "win32")).toBe(t);
		expect(tempDir({ TMP: t }, "win32")).toBe(t);
		expect(tempDir({})).toBe(tmpdir());
		expect(tempDir()).toBe(tmpdir());
	});

	test("expandHome leaves non-tilde paths alone", () => {
		expect(expandHome("rel/x", { [HOME_KEY]: home })).toBe("rel/x");
		expect(expandHome("~", { [HOME_KEY]: home })).toBe(home);
	});
});

describe("moduleFile", () => {
	test("resolves a sibling asset to an absolute path that exists", () => {
		const p = moduleFile(import.meta.url, "paths.ts");
		expect(isAbsolute(p)).toBe(true);
		expect(existsSync(p)).toBe(true);
	});
});
