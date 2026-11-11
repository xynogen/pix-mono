/**
 * env.ts — Detect environment info (git, platform) for subagent system prompts.
 *
 * git runs through pix-runtime (binary.json → agent bin → known dirs → PATH);
 * a missing git just means "not a repo" here — the footer and welcome panel
 * already surface the install hint.
 */

import type { ExtensionAPI } from "@xynogen/pix-runtime/host";
import { runGit } from "@xynogen/pix-runtime/os";
import { currentPlatform } from "@xynogen/pix-runtime/platform";
import type { EnvInfo } from "./types.ts";

async function git(cwd: string, args: string[]): Promise<string | null> {
	try {
		return await runGit(args, { cwd, timeoutMs: 5000 });
	} catch {
		return null;
	}
}

export async function detectEnv(_pi: ExtensionAPI, cwd: string): Promise<EnvInfo> {
	const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
	const isGitRepo = inside?.trim() === "true";
	const branch = isGitRepo
		? ((await git(cwd, ["branch", "--show-current"]))?.trim() ?? "unknown")
		: "";
	return { isGitRepo, branch, platform: currentPlatform().os };
}
