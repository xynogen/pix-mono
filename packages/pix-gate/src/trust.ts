/**
 * Simplified project-trust prompt.
 *
 * Pi's built-in prompt offers five choices (trust, trust parent, trust for
 * session, do not trust, do not trust for session). This handler replaces it
 * with two remembered choices: Trust / Do not trust. It only decides when Pi
 * would otherwise ask — saved decisions, `defaultProjectTrust` other than
 * "ask", and no-UI runs fall through to Pi unchanged ("undecided").
 */

import { join } from "node:path";
import { existsSync, readFileSync } from "@xynogen/pix-runtime/fs";
import {
	type ExtensionAPI,
	type ProjectTrustContext,
	type ProjectTrustEvent,
	type ProjectTrustEventResult,
	ProjectTrustStore,
} from "@xynogen/pix-runtime/host";
import { agentDir } from "@xynogen/pix-runtime/paths";

export const TRUST_LABEL = "Trust";
export const DISTRUST_LABEL = "Do not trust";

export interface TrustDeps {
	/** Saved decision for cwd (nearest ancestor), or null when none. */
	savedDecision(cwd: string): boolean | null;
	/** Global `defaultProjectTrust` setting. */
	defaultProjectTrust(): string;
}

function readDefaultProjectTrust(dir: string): string {
	const path = join(dir, "settings.json");
	if (!existsSync(path)) return "ask";
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8").replace(/^\uFEFF/, ""));
		const value = parsed?.defaultProjectTrust;
		return typeof value === "string" ? value : "ask";
	} catch {
		return "ask";
	}
}

export function defaultTrustDeps(dir: string = agentDir()): TrustDeps {
	return {
		savedDecision: (cwd) => new ProjectTrustStore(dir).get(cwd),
		defaultProjectTrust: () => readDefaultProjectTrust(dir),
	};
}

export async function decideProjectTrust(
	event: ProjectTrustEvent,
	ctx: ProjectTrustContext,
	deps: TrustDeps,
): Promise<ProjectTrustEventResult> {
	const undecided: ProjectTrustEventResult = { trusted: "undecided" };
	if (!ctx.hasUI) return undecided;
	if (deps.savedDecision(event.cwd) !== null) return undecided;
	if (deps.defaultProjectTrust() !== "ask") return undecided;

	const title =
		`Trust project folder?\n${event.cwd}\n\n` +
		"This allows Pi to load .pi settings and resources, install missing project packages, and execute project extensions.";
	const choice = await ctx.ui.select(title, [TRUST_LABEL, DISTRUST_LABEL]);
	if (choice === TRUST_LABEL) return { trusted: "yes", remember: true };
	if (choice === DISTRUST_LABEL) return { trusted: "no", remember: true };
	// Cancelled: untrusted for this run only, nothing saved (matches Pi).
	return { trusted: "no" };
}

export function registerProjectTrust(pi: ExtensionAPI, deps: TrustDeps = defaultTrustDeps()): void {
	pi.on("project_trust", (event, ctx) => decideProjectTrust(event, ctx, deps));
}
