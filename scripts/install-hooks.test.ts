import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runToolSync } from "@xynogen/pix-runtime/exec";
import { tempDir } from "@xynogen/pix-runtime/paths";
import { installHooks } from "./install-hooks.ts";

test("installs standard hooks, migrates legacy config, and preserves user hooks", () => {
	const cwd = mkdtempSync(join(tempDir(), "pix-hooks-"));
	// Inside a pre-commit hook, git exports GIT_INDEX_FILE etc. for the outer repo; drop them.
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
	);
	const git = (args: string[]) => {
		const result = runToolSync("git", args, { cwd, env });
		expect(result.code).toBe(0);
		return result.stdout.trim();
	};
	try {
		expect(installHooks(cwd)).toBeUndefined();
		git(["init", "--quiet"]);
		git(["config", "--local", "core.hooksPath", ".githooks"]);
		const target = installHooks(cwd) as string;
		expect(target).toBe(join(cwd, ".git", "hooks", "pre-commit"));
		expect(readFileSync(target, "utf8")).toMatch(
			/\.md\$'; then\n.*\n\texit 0\nfi\nbun run check\nbun run typecheck\nexec bun run test\n$/,
		);
		// Markdown-only commits skip the checks; any other staged file runs them.
		const runHook = () => runToolSync("bash", [target], { cwd, env });
		writeFileSync(join(cwd, "README.md"), "# x\n");
		git(["add", "README.md"]);
		expect(runHook().stdout).toMatch(/only Markdown staged; skipping checks/);
		writeFileSync(join(cwd, "a.ts"), "");
		git(["add", "a.ts"]);
		expect(runHook().stdout).not.toMatch(/skipping checks/);
		expect(runToolSync("git", ["config", "--get", "core.hooksPath"], { cwd }).code).toBe(1);
		if (process.platform !== "win32") chmodSync(target, 0o644);
		expect(installHooks(cwd)).toBe(target);
		if (process.platform !== "win32") expect(statSync(target).mode & 0o111).toBe(0o111);
		git(["config", "--local", "core.hooksPath", "custom-hooks"]);
		expect(() => installHooks(cwd)).toThrow("Preserving custom core.hooksPath");
		expect(git(["config", "--get", "core.hooksPath"])).toBe("custom-hooks");
		git(["config", "--local", "core.hooksPath", ".githooks"]);
		writeFileSync(target, "#!/bin/sh\nexit 1\n");
		expect(() => installHooks(cwd)).toThrow("Preserving existing hook");
		expect(readFileSync(target, "utf8")).toBe("#!/bin/sh\nexit 1\n");
		expect(git(["config", "--get", "core.hooksPath"])).toBe(".githooks");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
