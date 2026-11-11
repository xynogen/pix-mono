import type { ToolContext } from "@xynogen/pix-pretty/context";
import { registerShellTool } from "@xynogen/pix-pretty/shell-tool";
import type { PiPrettyApi, ToolFactory } from "@xynogen/pix-pretty/types";
import { dotJoin } from "@xynogen/pix-pretty/utils";
import type { BashToolInput } from "@xynogen/pix-runtime/host";

/** Script-shaped first statements: assignments and control-flow blocks. */
const SCRIPT_START_RE =
	/^(?:\$[\w:]+(?:\.\w+)*\s*[-+*/]?=|(?:if|elseif|else|foreach|for|while|do|switch|try|function|filter|param|begin|process|end)\b)/i;

/**
 * One-line summary for the auto-collapsed row: the first statement plus a
 * step count, or `script · N lines` for assignment/control-flow scripts.
 * Pipelines stay whole — `Get-ChildItem | Sort-Object` is one step.
 */
export function summarizePowerShellCommand(command: string): string {
	const lines: string[] = [];
	let inBlockComment = false;
	for (const raw of command.split("\n")) {
		let line = raw.trim();
		if (inBlockComment) {
			const end = line.indexOf("#>");
			if (end < 0) continue;
			inBlockComment = false;
			line = line.slice(end + 2).trim();
		}
		if (line.startsWith("<#")) {
			const end = line.indexOf("#>");
			if (end < 0) {
				inBlockComment = true;
				continue;
			}
			line = line.slice(end + 2).trim();
		}
		if (line && !line.startsWith("#")) lines.push(line);
	}
	const steps = lines
		.flatMap((line) => line.split(/\s*(?:&&|\|\||;)\s*/))
		.map((step) => step.trim())
		.filter(Boolean);

	if (steps.length === 0) return "command";
	const first = steps[0] ?? "command";
	if (SCRIPT_START_RE.test(first)) return dotJoin(["script", `${lines.length} lines`]);

	const compact = first.replace(/\s+/g, " ");
	return dotJoin([compact, steps.length > 1 && `+${steps.length - 1} steps`]);
}

/** Register the pretty-rendered `powershell` tool over Pi's built-in one. */
export function registerPowerShellTool(
	pi: PiPrettyApi,
	createPowerShellTool: ToolFactory<BashToolInput>,
	ctx: ToolContext,
): void {
	registerShellTool(pi, createPowerShellTool, ctx, {
		name: "powershell",
		summarize: summarizePowerShellCommand,
		failurePattern: /is not recognized as (?:the |a )?name of a cmdlet|CommandNotFoundException/,
	});
}
