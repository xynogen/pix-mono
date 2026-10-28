/**
 * capability-nudge.ts — orient the model to its full toolbelt
 *
 * Models drift toward improvising mid-session, forgetting they can ask the
 * user, search the web, pull library docs (context7), use LSP, or invoke an
 * Agent Skill instead of guessing. Hooks `before_agent_start` and adds one visible
 * custom message on selected turns only (see REMINDER_INTERVAL).
 *
 * Two modes:
 *   1. FIRST prompt of the session — an orientation block: counts of tools /
 *      MCP tools / skills and HOW to explore them. No full inventory: deferred
 *      tools are found with tool_search, skills with read_skills().
 *   2. Every REMINDER_INTERVAL-th turn thereafter (turns 11, 21, …) — the terse
 *      one-line CAPABILITY_REMINDER (~40 tok). All other turns inject nothing.
 *
 * `/toolbox` is a user slash command, not model-callable; never name it here.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
	BuildSystemPromptOptions,
	ExtensionAPI,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { projectDir } from "@xynogen/pix-runtime/paths";
import { CAPABILITY_MESSAGE } from "./card.ts";
import { registeredToolNames } from "./tools.ts";

type LoadedSkill = NonNullable<BuildSystemPromptOptions["skills"]>[number];

/** How often (in turns after the first) to re-send the capability reminder. */
const REMINDER_INTERVAL = 10;

/** The periodic reminder. Kept terse — it re-ships every REMINDER_INTERVAL turns. */
export const CAPABILITY_REMINDER =
	"Reminder — before you improvise, check skills (read_skills()), deferred tools (tool_search), " +
	"MCP, web, docs, or ask the user.";

/**
 * The reminder for this session: names `read_skills()`, `tool_search` and `mcp`
 * only when registered, so it never points at a tool the session lacks.
 * Unknown registry (`undefined`) → the full default reminder.
 */
export function capabilityReminder(registered: Set<string> | undefined): string {
	if (!registered) return CAPABILITY_REMINDER;
	const checks = [
		registered.has("read_skills") && "skills (read_skills())",
		registered.has("tool_search") && "deferred tools (tool_search)",
		registered.has("mcp") && "MCP",
		"web, docs, or ask the user",
	].filter(Boolean);
	return `Reminder — before you improvise, check ${checks.join(", ")}.`;
}

/**
 * Capability → tool map. A row shows only when a registered tool matches, so the
 * orientation never advertises a capability this session lacks.
 */
const CAPABILITIES: { match: (name: string) => boolean; label: string }[] = [
	{ match: (n) => n === "ask_user", label: "ask_user (unclear intent)" },
	{ match: (n) => n === "read_skills", label: "read_skills() (task-specific skills)" },
	{ match: (n) => /context7/i.test(n), label: "context7 (library docs)" },
	{ match: (n) => n === "search" || n === "fetch", label: "search/fetch (web)" },
	{ match: (n) => n.startsWith("lsp_"), label: "lsp_* (types, refs, diagnostics)" },
	{ match: (n) => n === "mcp", label: "mcp (MCP servers)" },
];

/** Labels of the capabilities present in `tools`, in CAPABILITIES order. */
export function capabilityLabels(tools: ToolInfo[] | undefined): string[] {
	const names = (tools ?? []).map((t) => t.name);
	return CAPABILITIES.filter((c) => names.some(c.match)).map((c) => c.label);
}

/**
 * Build the optional graph hint line.
 * Returns a string if a built graph.json exists in cwd (the pix-graph tool writes
 * `.pi/graph/`, external graphify / older CLI wrote `graphify-out/`), else undefined.
 */
export function graphifyHint(cwd: string): string | undefined {
	const dir = [`${projectDir()}/graph`, "graphify-out"].find((d) =>
		existsSync(join(cwd, d, "graph.json")),
	);
	if (dir) {
		return (
			`${dir}/graph.json exists — for codebase questions (how does X work, where is Y), ` +
			'call graph(action:"query", question:"<identifiers>") before reading files.'
		);
	}
	return undefined;
}

/** Count model-invocable skills (excludes user-only /skill:name entries). */
export function countInvocableSkills(skills: LoadedSkill[] | undefined): number {
	return (skills ?? []).filter((s) => !s.disableModelInvocation).length;
}

/**
 * Split tools by source (MCP vs other) and, when an `active` set is supplied,
 * by gate status (active = schema in the prompt now; gated = registered but
 * deferred, reachable only via tool_search). Without `active`, everything counts
 * as active (gated = 0) so callers that don't track the gate are unaffected.
 */
export function partitionTools(
	tools: ToolInfo[] | undefined,
	active?: Iterable<string>,
): {
	mcp: number;
	other: number;
	active: number;
	gated: number;
} {
	const activeSet = active ? new Set(active) : undefined;
	let mcp = 0;
	let other = 0;
	let activeCount = 0;
	let gated = 0;
	for (const t of tools ?? []) {
		if (/mcp/i.test(t.sourceInfo?.source ?? "")) mcp++;
		else other++;
		// A tool is "gated" only when we have an active set and it's absent from it.
		if (activeSet && !activeSet.has(t.name)) gated++;
		else activeCount++;
	}
	return { mcp, other, active: activeCount, gated };
}

/**
 * Build the one-time orientation block shown on the FIRST prompt: toolbelt counts,
 * the tool_search gate, a capability → tool map of what is actually registered,
 * and sorted skill names (no descriptions — read_skills() returns those).
 */
export function buildOrientation(
	tools: ToolInfo[] | undefined,
	skills: LoadedSkill[] | undefined,
	/** Currently-active tool names; absent ⇒ gate not tracked (all treated active). */
	activeToolNames?: Iterable<string>,
): string {
	const { mcp, other, gated } = partitionTools(tools, activeToolNames);
	const skillNames = (skills ?? [])
		.filter((s) => !s.disableModelInvocation)
		.map((s) => s.name)
		.sort();

	const inventory: string[] = [];
	if (other) inventory.push(`${other} tool${other === 1 ? "" : "s"}`);
	if (mcp) inventory.push(`${mcp} MCP tool${mcp === 1 ? "" : "s"}`);
	if (skillNames.length)
		inventory.push(`${skillNames.length} skill${skillNames.length === 1 ? "" : "s"}`);
	const summary = inventory.length ? inventory.join(", ") : "your toolbelt";

	// Lead with the gate: deferred tools are not callable until tool_search loads them.
	// Without tool_search (or an unknown registry) there is no way to load them, so skip it.
	const head = `Toolbelt: ${summary}.`;
	const canLoad = tools?.some((t) => t.name === "tool_search") ?? false;
	const lines = [
		gated && canLoad
			? `${head} ${gated} ${gated === 1 ? "is" : "are"} deferred (schemas kept out of context): load with tool_search("<exact name below, or the task>") before the first call.`
			: head,
	];
	const caps = capabilityLabels(tools);
	lines.push(
		caps.length
			? `Before you improvise, use: ${caps.join(" · ")}.`
			: "Before you improvise, ask the user, search the web, or pull docs.",
	);
	if (skillNames.length) {
		lines.push(`Skills: ${skillNames.join(", ")}.`);
	}
	// Graph hint — only when a graph is built and the graph tool can query it.
	const gHint = graphifyHint(process.cwd());
	if (gHint && (!tools || tools.some((t) => t.name === "graph"))) lines.push(gHint);
	// Framing — this block is orientation context, not a task. Without it the
	// model can mistake the first-turn orientation for the prompt and reply
	// "Ready, waiting for task" instead of acting on the user's request.
	lines.push(
		"(Orientation only — not a task. Act on the user's request now; do not reply to this notice.)",
	);
	return lines.join("\n");
}

export default function registerCapabilityNudge(pi: ExtensionAPI): void {
	let turnCount = 0;

	pi.on("before_agent_start", async (event) => {
		// Runs started by sendMessage(triggerTurn) are extension follow-ups, not user turns.
		if (event.messageType === "custom") return;
		const skills = event.systemPromptOptions?.skills;
		turnCount++;

		let content: string;
		let details: { kind: string; summary: string };
		if (turnCount === 1) {
			let tools: ToolInfo[] | undefined;
			try {
				tools = pi.getAllTools();
			} catch {
				tools = undefined;
			}
			// Active set lets the orientation distinguish callable-now from gated.
			// getActiveTools() returns string[] (tool NAMES) — not ToolInfo[]. Use as-is.
			let activeToolNames: string[] | undefined;
			try {
				activeToolNames = pi.getActiveTools();
			} catch {
				activeToolNames = undefined;
			}
			content = buildOrientation(tools, skills, activeToolNames);
			const { gated } = partitionTools(tools, activeToolNames);
			const caps = capabilityLabels(tools).length;
			details = {
				kind: "orientation",
				summary: [
					`${tools?.length ?? 0} tools`,
					gated && `${gated} deferred`,
					// caps = helper tools named in the "Before you improvise" line (ask_user, search, mcp…).
					caps && `${caps} capabilities`,
				]
					.filter(Boolean)
					.join(" · "),
			};
		} else if (turnCount % REMINDER_INTERVAL === 1) {
			// Fire reminder every REMINDER_INTERVAL turns (turn 11, 21, ...)
			const registered = registeredToolNames(pi);
			const gHint =
				registered && !registered.has("graph") ? undefined : graphifyHint(process.cwd());
			const reminder = capabilityReminder(registered);
			content = gHint ? `${reminder}\n${gHint}` : reminder;
			details = { kind: "reminder", summary: "check skills, tool_search, web, docs, user" };
		} else {
			return; // no nudge this turn
		}

		// A visible message, not a system-prompt rewrite: a returned systemPrompt
		// becomes forceSystemPrompt for that one turn, so the prompt changes and then
		// reverts, invalidating the cached prefix twice per nudge. `details` feeds the
		// collapsed card row (see card.ts); the model reads only `content`.
		return { message: { customType: CAPABILITY_MESSAGE, content, display: true, details } };
	});
}
