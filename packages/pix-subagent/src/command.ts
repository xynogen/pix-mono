/**
 * command.ts — `/agent`: the user launches a background sub-agent, like `/btw`.
 *
 * The agent runs in the shared manager (same widget, same agent_control), but its
 * result lands as a display-only card: it never steers or wakes the main agent.
 */

import { getErrorMessage } from "@xynogen/pix-pretty/utils";
import type { ExtensionAPI, ExtensionCommandContext } from "@xynogen/pix-runtime/host";
import type { AgentManager } from "./agent-manager.ts";
import { normalizeMaxTurns } from "./agent-runner.ts";
import { getAgentConfig, getAvailableTypes, resolveType } from "./agent-types.ts";
import { resolveAgentInvocationConfig } from "./invocation-config.ts";
import { resolveModel } from "./model-resolver.ts";
import { createActivityTracker, shortModelLabel } from "./tools.ts";
import type { AgentActivity, AgentInvocation } from "./types.ts";

export interface AgentCommandArgs {
	prompt: string;
	type?: string;
	model?: string;
	/** Fork the main conversation into the agent (off by default: cost grows with history). */
	ctx: boolean;
}

/** Parse `/agent [--type <t>] [--model <m>] [--ctx] <prompt>`. Flags may sit anywhere. */
export function parseAgentArgs(raw: string): AgentCommandArgs | string {
	const tokens = raw.trim().split(/\s+/).filter(Boolean);
	const words: string[] = [];
	const out: AgentCommandArgs = { prompt: "", ctx: false };
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (token === "--ctx") out.ctx = true;
		else if (token === "--type" || token === "--model") {
			const value = tokens[++i];
			if (!value || value.startsWith("--")) return `${token} needs a value.`;
			out[token === "--type" ? "type" : "model"] = value;
		} else words.push(token);
	}
	out.prompt = words.join(" ");
	return out;
}

/** Short widget label: the first words of the prompt. */
export function describePrompt(prompt: string): string {
	const words = prompt.split(/\s+/);
	return words.length > 5 ? `${words.slice(0, 5).join(" ")}…` : prompt;
}

function usage(): string {
	return [
		"Usage: /agent [--type <type>] [--model <model>] [--ctx] <prompt>",
		"Runs a background sub-agent. The main agent keeps going; the result lands as a card.",
		`  --type   ${getAvailableTypes().join(", ")} (default: general)`,
		"  --model  provider/model or a fuzzy name (default: current model)",
		"  --ctx    fork the main conversation into the agent",
	].join("\n");
}

export function registerAgentCommand(
	pi: ExtensionAPI,
	manager: AgentManager,
	agentActivity: Map<string, AgentActivity>,
	reloadCustomAgents: () => void,
): void {
	pi.registerCommand("agent", {
		description: "Launch a background sub-agent without interrupting the main agent",
		handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
			reloadCustomAgents();
			const args = parseAgentArgs(rawArgs);
			if (typeof args === "string" || !args.prompt) {
				ctx.ui.notify(typeof args === "string" ? `${args}\n${usage()}` : usage(), "warning");
				return;
			}
			const type = args.type ? resolveType(args.type) : "general";
			if (!type || !getAvailableTypes().includes(type)) {
				ctx.ui.notify(
					`Unknown agent type "${args.type}". Available: ${getAvailableTypes().join(", ")}`,
					"error",
				);
				return;
			}
			const config = resolveAgentInvocationConfig(getAgentConfig(type), {
				model: args.model,
				...(args.ctx ? { inherit_context: true } : {}),
			});
			// The user's explicit model choice is used as given, or the command fails visibly.
			let model = ctx.model;
			if (config.modelInput) {
				const resolved = resolveModel(config.modelInput, ctx.modelRegistry);
				if (typeof resolved !== "string") model = resolved;
				else if (config.modelFromParams) {
					ctx.ui.notify(resolved, "error");
					return;
				}
			}
			const maxTurns = normalizeMaxTurns(config.maxTurns);
			const invocation: AgentInvocation = {
				modelName: model ? shortModelLabel(model) : undefined,
				thinking: config.thinking,
				maxTurns,
				isolated: config.isolated,
				inheritContext: config.inheritContext,
				fromCommand: true,
			};
			let id = "";
			const { state, callbacks } = createActivityTracker(maxTurns, () => {
				if (id) agentActivity.set(id, state);
			});
			try {
				id = manager.spawn(pi, ctx, type, args.prompt, {
					description: describePrompt(args.prompt),
					model,
					maxTurns,
					isolated: config.isolated,
					inheritContext: config.inheritContext,
					thinkingLevel: config.thinking,
					isBackground: true,
					invocation,
					// No signal: the agent outlives this command, like /btw.
					...callbacks,
				});
			} catch (error) {
				ctx.ui.notify(getErrorMessage(error), "error");
				return;
			}
			agentActivity.set(id, state);
			const record = manager.getRecord(id);
			if (record) record.isBackground = true;
			ctx.ui.notify(`Agent ${id} started — the main agent will keep running.`, "info");
		},
	});
}
