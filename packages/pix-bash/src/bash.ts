import type { ToolContext } from "@xynogen/pix-pretty/context";
import { registerShellTool } from "@xynogen/pix-pretty/shell-tool";
import type { PiPrettyApi, ToolFactory } from "@xynogen/pix-pretty/types";
import { dotJoin } from "@xynogen/pix-pretty/utils";
import { formatDuration } from "@xynogen/pix-pretty/widget-format";
import type { BashToolInput } from "@xynogen/pix-runtime/host";

// Re-exported for existing importers; canonical home is pix-pretty/shell-tool.
export { collapseProgressFrames } from "@xynogen/pix-pretty/shell-tool";

export function summarizeBashCommand(command: string): string {
	const lines = command
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && line !== "set -e" && !line.startsWith("#"));
	const steps = lines
		.flatMap((line) => line.split(/\s*(?:&&|\|\||;)\s*/))
		.map((step) => step.trim())
		.filter(Boolean);

	if (steps.length === 0) return "command";
	const first = steps[0] ?? "command";
	if (/^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=|^(?:if|for|while|case)\b/.test(first)) {
		return dotJoin(["shell script", `${lines.length} lines`]);
	}

	const compact = first.replace(/\s+/g, " ");
	return dotJoin([compact, steps.length > 1 && `+${steps.length - 1} steps`]);
}

// ponytail: thin wrapper keeps old import path; canonical is formatDuration(ms,'bash') in pix-pretty
export function formatBashDuration(durationMs: number): string {
	return formatDuration(durationMs, "bash");
}

export function registerBashTool(
	pi: PiPrettyApi,
	createBashTool: ToolFactory<BashToolInput>,
	ctx: ToolContext,
): void {
	registerShellTool(pi, createBashTool, ctx, {
		name: "bash",
		summarize: summarizeBashCommand,
		failurePattern: /command not found|No such file/,
	});
}
