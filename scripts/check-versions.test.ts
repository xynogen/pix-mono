import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Sandbox {
	root: string;
	scriptPath: string;
}

let sandbox: Sandbox | undefined;

async function setupSandbox(): Promise<Sandbox> {
	const root = mkdtempSync(join(tmpdir(), "pix-check-versions-"));
	// Copy the real script under test so the test exercises the same source.
	const source = join(import.meta.dir, "check-versions.ts");
	const scriptsDir = join(root, "scripts");
	mkdirSync(scriptsDir, { recursive: true });
	const scriptPath = join(scriptsDir, "check-versions.ts");
	const script = await Bun.file(source).text();
	const releaseTagHelper = await Bun.file(join(import.meta.dir, "release-tag.ts")).text();
	await Bun.write(scriptPath, script);
	await Bun.write(join(scriptsDir, "release-tag.ts"), releaseTagHelper);

	// Initialise a temporary git repo so the test can control the release
	// baseline independently of the checkout depth and tags in CI.
	spawnSync("git", ["init", "-q", "--initial-branch=main"], { cwd: root });
	spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
	spawnSync("git", ["config", "user.name", "Test"], { cwd: root });

	// Scaffold three packages so each test can distinguish a version bump
	// from unchanged manifests and dependency-only edits.
	const packagesDir = join(root, "packages");
	mkdirSync(join(packagesDir, "stale"), { recursive: true });
	mkdirSync(join(packagesDir, "fresh"), { recursive: true });
	mkdirSync(join(packagesDir, "stable"), { recursive: true });

	writeFileSync(
		join(packagesDir, "stale", "package.json"),
		JSON.stringify({ name: "stale-pkg", version: "1.0.0" }, null, "\t"),
	);
	writeFileSync(
		join(packagesDir, "fresh", "package.json"),
		JSON.stringify({ name: "fresh-pkg", version: "1.0.0" }, null, "\t"),
	);
	writeFileSync(
		join(packagesDir, "stable", "package.json"),
		JSON.stringify(
			{ name: "stable-pkg", version: "1.0.0", dependencies: { lodash: "^4.0.0" } },
			null,
			"\t",
		),
	);

	spawnSync("git", ["add", "-A"], { cwd: root });
	spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
	// Tag the initial state as a release so the guard can find a baseline.
	spawnSync("git", ["tag", "release-20240101-0000"], { cwd: root });

	return { root, scriptPath };
}

function teardownSandbox(sandbox: Sandbox): void {
	rmSync(sandbox.root, { recursive: true, force: true });
}

function runCheckVersions(sandbox: Sandbox): {
	stdout: string;
	stderr: string;
	status: number;
} {
	const result = spawnSync("bun", [sandbox.scriptPath], {
		cwd: sandbox.root,
		encoding: "utf8",
	});
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		status: result.status ?? -1,
	};
}

beforeEach(async () => {
	sandbox = await setupSandbox();
});

afterEach(() => {
	if (sandbox) teardownSandbox(sandbox);
	sandbox = undefined;
});

describe("check-versions pre-publish guard", () => {
	test("rejects package changes without a version bump", () => {
		if (!sandbox) throw new Error("sandbox not initialised");
		const sourceDir = join(sandbox.root, "packages/stable/src");
		mkdirSync(sourceDir, { recursive: true });
		writeFileSync(join(sourceDir, "index.ts"), "export const changed = true;\n");
		spawnSync("git", ["add", "-A"], { cwd: sandbox.root });
		spawnSync("git", ["commit", "-q", "-m", "change source without bump"], { cwd: sandbox.root });

		const { stdout, stderr, status } = runCheckVersions(sandbox);
		expect(`${stdout}${stderr}`).toContain(
			"stable-pkg@1.0.0 — package changed but version was not bumped",
		);
		expect(status).toBe(1);
	});

	test("reports only packages whose version changed", () => {
		if (!sandbox) throw new Error("sandbox not initialised");
		writeFileSync(
			join(sandbox.root, "packages/fresh/package.json"),
			JSON.stringify({ name: "fresh-pkg", version: "1.0.1" }, null, "\t"),
		);
		spawnSync("git", ["add", "-A"], { cwd: sandbox.root });
		spawnSync("git", ["commit", "-q", "-m", "bump fresh"], { cwd: sandbox.root });

		const { stdout, stderr } = runCheckVersions(sandbox);
		const output = `${stdout}${stderr}`;
		expect(output).toContain("Checking 1 changed package(s)");
		expect(output).toContain("fresh-pkg");
		expect(output).not.toContain("stale-pkg");
		expect(output).not.toContain("stable-pkg");
	});
});
