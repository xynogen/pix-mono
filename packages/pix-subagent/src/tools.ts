/**
 * tools.ts — The 4 LLM-callable tool definitions:
 *   agent          — spawn a sub-agent (fg or bg)
 *   agent_info     — discover available types or models on demand
 *   agent_result   — fetch latest output / full result by id
 *   agent_steer    — steer or force-stop a running bg agent
 *
 * Design notes:
 * - volatile model/type catalogs live behind agent_info, not the agent schema.
 * - allowed_tools[] intersects the resolved tool set (never widens).
 * - modelName is ALWAYS populated (the pix twist — shown even when same as parent).
 * - renderCall/renderResult ported from tintinweb/pi-subagents (MIT).
 *
 * Token-cost note: the `agent` tool is the most expensive call the LLM makes
 * (a detailed `prompt` field alone is 50-200 output tokens). Parameter keys are
 * kept short (`type`, `turns`, `background`) and rare options (`isolated`,
 * `inherit_context`) are intentionally absent from the schema — they bloat
 * every call with `false` fillers yet are almost never used. They remain
 * configurable via custom agent .md frontmatter (../custom-agents.ts) for the
 * rare case that needs them.
 */

import { defineTool, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { lookupBenchmark } from "@xynogen/pix-data";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import {
	COLLAPSED_TOOL_GLYPH,
	dotJoin,
	formatCollapsedToolRow,
	hideCollapsedToolCall,
	padIcon,
} from "@xynogen/pix-pretty/utils";
import {
	describeActivity,
	formatContext,
	formatMs,
	formatSpeed,
	formatToolUses,
	formatTurns,
	SPINNER,
} from "@xynogen/pix-pretty/widget-format";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";
import { Type } from "typebox";
import type { AgentManager } from "./agent-manager.ts";
import {
	getAgentConversation,
	getAgentLastTurns,
	normalizeMaxTurns,
	SUBAGENT_TOOL_NAMES,
} from "./agent-runner.ts";
import { BUILTIN_TOOL_NAMES, getAgentConfig, getAvailableTypes, getConfig } from "./agent-types.ts";
import { resolveAgentInvocationConfig } from "./invocation-config.ts";
import {
	listAvailable,
	type ModelEntry,
	type ModelRegistry,
	resolveModel,
} from "./model-resolver.ts";
import type {
	AgentInfoResultDetails,
	AgentInvocation,
	AgentResultDetails,
	AgentSteerResultDetails,
	AgentUtilityResultDetails,
	LifetimeUsage,
} from "./types.ts";
import { getSessionContextUsage, type SessionLike } from "./usage.ts";

// ── Types shared with ui/widget.ts (widget imports from here to avoid circular) ─

export type Theme = {
	fg(color: string, text: string): string;
	bold(text: string): string;
};

export interface AgentActivity {
	activeTools: Map<string, string>;
	toolUses: number;
	responseText: string;
	session?: unknown;
	turnCount: number;
	maxTurns?: number;
	lifetimeUsage: LifetimeUsage;
	/** Cumulative milliseconds spent streaming output (not idle/tool time). */
	streamingMs: number;
}

export interface AgentDetails {
	displayName: string;
	description: string;
	subagentType: string;
	toolUses: number;
	/** Context-window utilization as a pre-formatted string (e.g. "30.1K/1.00M (3%)"), or "" when unavailable. */
	context: string;
	/** Raw output tokens — for t/s = outputTokens / streamingMs. */
	outputTokens?: number;
	durationMs: number;
	/** Cumulative streaming-only milliseconds (for accurate t/s). */
	streamingMs?: number;
	status:
		| "queued"
		| "running"
		| "completed"
		| "steered"
		| "aborted"
		| "stopped"
		| "error"
		| "background";
	activity?: string;
	spinnerFrame?: number;
	modelName?: string;
	tags?: string[];
	turnCount?: number;
	maxTurns?: number;
	agentId?: string;
	error?: string;
}

// ── Formatting helpers (shared, re-exported for ui/widget.ts + back-compat) ──
// SPINNER, formatTokens, fmtTokenCount, formatContext, formatTurns,
// formatToolUses, formatMs, formatSpeed, TOOL_DISPLAY, describeActivity now
// live in @xynogen/pix-pretty/widget-format. Re-exported here so existing
// `from "../tools.ts"` imports keep resolving.
export {
	describeActivity,
	fmtTokenCount,
	formatContext,
	formatMs,
	formatSpeed,
	formatTokens,
	formatToolUses,
	formatTurns,
	SPINNER,
	TOOL_DISPLAY,
} from "@xynogen/pix-pretty/widget-format";

/** Render the agent call header and, until auto-collapse, its task prompt. */
export function formatAgentCall(
	args: Record<string, unknown>,
	theme: Theme,
	showPrompt = true,
): string {
	const typeName = resolveTypeName(args);
	const displayName = typeName ? getConfig(typeName).displayName : "Agent";
	const description = typeof args.description === "string" ? args.description : "";
	const model = typeof args.model === "string" ? args.model : "";
	const prompt = typeof args.prompt === "string" ? args.prompt : "";
	const modelStr = model ? ` ${theme.fg("muted", `[${model}]`)}` : "";
	const header =
		"▸ " +
		theme.fg("toolTitle", theme.bold(displayName)) +
		modelStr +
		(description ? `  ${theme.fg("muted", description)}` : "");

	// renderCall replaces Pi's default argument renderer. Initially retain the
	// task context, then let the shared pix collapse timer reduce it to the header.
	return showPrompt && prompt ? `${header}\n${theme.fg("dim", JSON.stringify(prompt))}` : header;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function textResult(
	msg: string,
	details?: AgentDetails | AgentInfoResultDetails | AgentResultDetails | AgentSteerResultDetails,
) {
	return {
		content: [{ type: "text" as const, text: msg }],
		details: details as unknown,
	};
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

function renderAgentUtilityResult(
	result: { content: { type: string; text?: string }[]; details?: unknown },
	expanded: boolean,
	theme: Theme,
	renderCtx: { state: Record<string, unknown>; invalidate: () => void },
): Text {
	const details = result.details as AgentUtilityResultDetails | undefined;
	const text = resultText(result);
	if (!details || expanded) return new Text(text, 0, 0);
	const collapseTool =
		details._type === "agent-info"
			? SUBAGENT_TOOL_NAMES.INFO
			: details._type === "agent-result"
				? SUBAGENT_TOOL_NAMES.GET_RESULT
				: SUBAGENT_TOOL_NAMES.STEER;
	if (
		!tickCollapse(collapseTool, renderCtx.state as CollapseState, renderCtx.invalidate, expanded)
	) {
		return new Text(text, 0, 0);
	}

	if (details._type === "agent-info") {
		return new Text(
			formatCollapsedToolRow(
				theme,
				SUBAGENT_TOOL_NAMES.INFO,
				details.query ? `${details.kind} “${details.query}”` : details.kind,
				`${details.count} available`,
			),
			0,
			0,
		);
	}

	if (details._type === "agent-result") {
		const meta =
			details.status === "running"
				? "still running"
				: details.status === "not-found"
					? "not found"
					: details.turns != null
						? `last ${details.turns} turn${details.turns === 1 ? "" : "s"}`
						: details.status;
		const status =
			details.status === "completed" || details.status === "steered"
				? "success"
				: details.status === "running" ||
						details.status === "queued" ||
						details.status === "aborted" ||
						details.status === "stopped"
					? "warning"
					: "error";
		const row = formatCollapsedToolRow(
			theme,
			SUBAGENT_TOOL_NAMES.GET_RESULT,
			details.agentId,
			meta,
			status,
		);
		return new Text(
			details.status === "stopped"
				? row.replace(
						theme.fg("warning", padIcon(COLLAPSED_TOOL_GLYPH.warning)),
						theme.fg("dim", padIcon("■")),
					)
				: row,
			0,
			0,
		);
	}

	const tool = details.action === "stop" ? "agent_stop" : SUBAGENT_TOOL_NAMES.STEER;
	const meta =
		details.outcome === "stopped" && text.includes("Partial output saved")
			? "partial output saved"
			: details.outcome === "already-finished"
				? "already finished"
				: details.outcome === "not-found"
					? "not found"
					: details.outcome;
	if (details.outcome === "stopped") {
		const row = formatCollapsedToolRow(theme, tool, details.agentId, meta);
		return new Text(
			row.replace(theme.fg("success", padIcon("✓")), theme.fg("dim", padIcon("■"))),
			0,
			0,
		);
	}
	const status =
		details.outcome === "delivered"
			? "success"
			: details.outcome === "queued" || details.outcome === "already-finished"
				? "warning"
				: "error";
	return new Text(formatCollapsedToolRow(theme, tool, details.agentId, meta, status), 0, 0);
}

/** Strip provider prefix + date suffix for a compact model label. e.g. "anthropic/claude-haiku-4-5-20251001" → "haiku-4-5" */
function shortModelLabel(model: { provider: string; id: string; name?: string }): string {
	// prefer name, strip "Claude " prefix
	if (model.name) return model.name.replace(/^Claude\s+/i, "").toLowerCase();
	const id = model.id.replace(/-\d{8}$/, ""); // strip date suffix
	return id;
}

function buildStats(d: AgentDetails, theme: Theme): string {
	const parts: string[] = [];
	if (d.modelName) parts.push(theme.fg("muted", `[${d.modelName}]`));
	if (d.tags) parts.push(...d.tags.map((t) => theme.fg("dim", t)));
	if (d.turnCount != null && d.turnCount > 0)
		parts.push(theme.fg("dim", formatTurns(d.turnCount, d.maxTurns)));
	if (d.toolUses > 0) parts.push(theme.fg("dim", formatToolUses(d.toolUses)));
	if (d.context) parts.push(theme.fg("dim", d.context));
	return dotJoin(parts, (s) => theme.fg("dim", s));
}

/** Format every foreground terminal state with stable identity-first ordering. */
export function formatAgentFinishedLine(d: AgentDetails, theme: Theme): string {
	let marker: string;
	let status: string;
	switch (d.status) {
		case "completed":
			marker = theme.fg("success", padIcon(icon("status.ok")));
			status = "completed";
			break;
		case "steered":
			marker = theme.fg("success", padIcon(icon("status.ok")));
			status = "steered (turn limit)";
			break;
		case "stopped":
			marker = theme.fg("dim", padIcon("■"));
			status = "stopped";
			break;
		case "aborted":
			marker = theme.fg("warning", padIcon(COLLAPSED_TOOL_GLYPH.warning));
			status = "aborted (max turns exceeded)";
			break;
		default: {
			marker = theme.fg("error", padIcon(icon("status.error")));
			const reason = d.error?.replace(/\s+/g, " ").trim().slice(0, 100);
			status = reason ? `error: ${reason}` : "error";
			break;
		}
	}

	const parts: string[] = [];
	if (d.description) parts.push(theme.fg("muted", d.description));
	const stats = buildStats(d, theme);
	if (stats) parts.push(stats);
	const speed = formatSpeed(d.outputTokens ?? 0, d.streamingMs ?? d.durationMs);
	if (speed) parts.push(theme.fg("dim", speed));
	parts.push(theme.fg("dim", formatMs(d.durationMs)));
	parts.push(theme.fg(d.status === "error" ? "error" : "dim", status));

	const dot = (s: string) => theme.fg("dim", s);
	return dotJoin([`${marker} ${theme.fg("toolTitle", theme.bold(d.displayName))}`, ...parts], dot);
}

/** Backward-compatible name for completed-row consumers. */
export function formatAgentCompletedLine(d: AgentDetails, theme: Theme): string {
	return formatAgentFinishedLine(d, theme);
}

// ── compact tool description + on-demand discovery ──────────────────────────

export function buildAgentToolDescription(): string {
	return "Launch a sub-agent only for delegated work; use direct tools for known tasks. Call agent_info to discover types or models. Keep prompts self-contained and never fork/inherit parent context. Use thinking medium or high; anything above high requires prior user approval after a concrete benefit and cost/latency justification. Omit model to inherit the parent model.";
}

export function agentTypeGuidance(): string {
	return `Pass one type name to agent.type. Custom agents: .pi/agents/*.md or ${getAgentDir()}/agents/*.md (project overrides global).`;
}

function normalizeQuery(query: unknown): string {
	return typeof query === "string" ? query.trim().toLocaleLowerCase() : "";
}

function boundedLimit(limit: unknown): number {
	return typeof limit === "number" && Number.isFinite(limit)
		? Math.max(1, Math.min(50, Math.floor(limit)))
		: 20;
}

export function listAgentTypes(query?: string, limit = 20): string[] {
	const needle = normalizeQuery(query);
	return getAvailableTypes()
		.map((name) => {
			const cfg = getAgentConfig(name);
			const description = (cfg?.description ?? name).replace(/\s+/g, " ").trim();
			const tools = cfg?.builtinToolNames;
			return {
				name,
				line: `- ${name}: ${description} (tools:${!tools || tools.length === BUILTIN_TOOL_NAMES.length ? "*" : tools.join(",")})`,
				search: `${name} ${description}`.toLocaleLowerCase(),
			};
		})
		.filter((entry) => !needle || entry.search.includes(needle))
		.slice(0, boundedLimit(limit))
		.map((entry) => entry.line);
}

export function listAgentModels(registry: ModelRegistry, query?: string, limit = 20): string[] {
	const needle = normalizeQuery(query);
	return listAvailable(registry)
		.filter((line) => !needle || line.toLocaleLowerCase().includes(needle))
		.slice(0, boundedLimit(limit));
}

export function describeParentModel(registry: ModelRegistry, model?: ModelEntry): string {
	if (!model) return "unknown";
	const id = `${model.provider}/${model.id}`;
	return listAvailable(registry).find((line) => line === id || line.startsWith(`${id}  —`)) ?? id;
}

export function createAgentInfoTool(reloadCustomAgents: () => void) {
	return defineTool({
		name: SUBAGENT_TOOL_NAMES.INFO,
		label: "Agent Info",
		renderShell: "self",
		description: "List runtime agent types or available models.",
		parameters: Type.Object({
			kind: Type.Enum(["types", "models"] as const, {
				type: "string",
				description: 'Catalog: "types" = roles/tools; "models" = available models.',
			}),
			query: Type.Optional(Type.String({ description: "Optional text filter." })),
			limit: Type.Optional(
				Type.Number({
					description: "Maximum results (default 20, max 50).",
					minimum: 1,
					maximum: 50,
				}),
			),
		}),
		renderCall(args, theme, renderCtx) {
			const text = new Text("", 0, 0);
			if (
				hideCollapsedToolCall(renderCtx.state as CollapseState, renderCtx.expanded, (value) =>
					text.setText(value),
				)
			)
				return text;
			const kind = String(args.kind ?? "types");
			const query = typeof args.query === "string" && args.query ? ` “${args.query}”` : "";
			text.setText(`${theme.fg("toolTitle", theme.bold("agent_info"))} ${kind}${query}`);
			return text;
		},

		renderResult(result, { expanded }, theme, renderCtx) {
			return renderAgentUtilityResult(result, expanded, theme, renderCtx);
		},

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const query = params.query as string | undefined;
			const limit = boundedLimit(params.limit);
			if (params.kind === "types") reloadCustomAgents();
			const lines =
				params.kind === "models"
					? listAgentModels(ctx.modelRegistry, query, limit)
					: listAgentTypes(query, limit);
			const heading = params.kind === "models" ? "Available models" : "Available agent types";
			const guidance =
				params.kind === "models"
					? "Pass provider/id or a fuzzy name to agent.model; omit model to inherit the parent."
					: agentTypeGuidance();
			const parent =
				params.kind === "models"
					? `Current parent: ${describeParentModel(ctx.modelRegistry, ctx.model)}\n\n`
					: "";
			return textResult(
				`${parent}${heading}${query ? ` matching “${query}”` : ""}:\n${lines.join("\n") || "(none)"}\n\n${guidance}`,
				{
					_type: "agent-info",
					kind: params.kind,
					query,
					count: lines.length,
				},
			);
		},
	});
}

// ── agent tool ───────────────────────────────────────────────────────────────

export function createAgentTool(
	pi: Parameters<typeof manager.spawn>[0],
	manager: AgentManager,
	agentActivity: Map<string, AgentActivity>,
	reloadCustomAgents: () => void,
) {
	return defineTool({
		name: SUBAGENT_TOOL_NAMES.AGENT,
		label: "Agent",
		renderShell: "self",
		description: buildAgentToolDescription(),
		promptSnippet: "Launch autonomous sub-agents for complex multi-step tasks",

		parameters: Type.Object({
			prompt: Type.String({
				description: "Compact, self-contained instructions; never rely on forked parent context.",
			}),
			description: Type.String({ description: "Short 3-5 word UI label." }),
			type: Type.String({ description: "Agent type; see agent_info(kind:'types')." }),
			model: Type.Optional(
				Type.String({ description: "Optional model override; omit to inherit." }),
			),
			allowed_tools: Type.Optional(
				Type.Array(Type.String(), { description: "General-purpose tool restriction." }),
			),
			thinking: Type.Optional(
				Type.Enum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, {
					type: "string",
					description:
						'Reasoning effort. Use only "medium" (default) or "high" unless the user explicitly approves a higher level after a concrete benefit and cost/latency justification.',
				}),
			),
			turns: Type.Optional(
				Type.Number({ description: "Maximum turns; omit for unlimited.", minimum: 1 }),
			),
			resume: Type.Optional(Type.String({ description: "Agent ID to continue." })),
			background: Type.Optional(
				Type.Boolean({ description: "Run asynchronously. Default true.", default: true }),
			),
		}),

		renderCall(args, theme, renderCtx) {
			const collapsed = tickCollapse(
				SUBAGENT_TOOL_NAMES.AGENT,
				renderCtx.state as CollapseState,
				renderCtx.invalidate,
				renderCtx.expanded,
			);
			return new Text(formatAgentCall(args as Record<string, unknown>, theme, !collapsed), 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as AgentDetails | undefined;
			if (!details) {
				const text = result.content[0]?.type === "text" ? result.content[0].text : "";
				return new Text(text, 0, 0);
			}

			// Streaming / running — show a compact live status line so the model
			// and activity are visible inline in the transcript (the ● Agents
			// widget carries full detail above the editor).
			if (isPartial || details.status === "running") {
				const frame =
					details.spinnerFrame != null
						? (SPINNER[details.spinnerFrame % SPINNER.length] ?? "⠋")
						: "⠋";
				const modelLabel = details.modelName
					? ` ${theme.fg("muted", `[${details.modelName}]`)}`
					: "";

				const parts: string[] = [];
				if (details.turnCount != null && details.turnCount > 0)
					parts.push(formatTurns(details.turnCount, details.maxTurns));
				if (details.toolUses > 0) parts.push(formatToolUses(details.toolUses));
				if (details.context) parts.push(details.context);
				const liveSpeed = formatSpeed(details.outputTokens ?? 0, details.streamingMs ?? 0);
				if (liveSpeed) parts.push(liveSpeed);
				if (details.durationMs > 0) parts.push(formatMs(details.durationMs));
				if (details.activity) parts.push(details.activity);
				const dot = (s: string) => theme.fg("dim", s);
				const statsText = parts.length > 0 ? dot(dotJoin(parts)) : "";

				const line = dotJoin(
					[
						`  ${theme.fg("accent", frame)} ${theme.fg("toolTitle", theme.bold(details.displayName))}${modelLabel}`,
						`${theme.fg("muted", details.description)}${statsText}`,
					],
					dot,
				);
				return new Text(line, 0, 0);
			}

			// Background launched
			if (details.status === "background") {
				const modelTag = details.modelName ? ` ${theme.fg("muted", `[${details.modelName}]`)}` : "";
				return new Text(
					theme.fg("dim", `  ⎿  Launched${modelTag} — result auto-delivered on completion`),
					0,
					0,
				);
			}

			// Every terminal branch uses the same one-line identity and stats order.
			// Expansion appends the existing bounded model-visible result beneath it.
			let line = formatAgentFinishedLine(details, theme);
			if (expanded) {
				const resultText = result.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n");
				if (resultText) {
					const resultLines = resultText.split("\n");
					for (const resultLine of resultLines.slice(0, 50)) {
						line += `\n${theme.fg("dim", `  ${resultLine}`)}`;
					}
					if (resultLines.length > 50) {
						line += `\n${theme.fg("muted", "  … (use agent_result with verbose for full output)")}`;
					}
				}
			}
			return new Text(line, 0, 0);
		},

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			reloadCustomAgents();

			// Resolve agent type — accept the new `type` key, with the legacy
			// `subagent_type` spelling kept as a fallback so RPC/older callers
			// and persisted invocations don't break. The typed schema no longer
			// declares the legacy key, so read it via a loose record view.
			const looseParams = params as Record<string, unknown>;
			const rawType =
				(params.type as string | undefined) ??
				(looseParams.subagent_type as string | undefined) ??
				"general";
			const resolvedKey =
				getAvailableTypes().find((t) => t.toLowerCase() === rawType.toLowerCase()) ?? rawType;
			const subagentType = getAvailableTypes().includes(resolvedKey) ? resolvedKey : "general";
			const fellBack = subagentType === "general" && resolvedKey !== "general";

			const displayName = getConfig(subagentType).displayName;
			const customConfig = getAgentConfig(subagentType);

			// Accept new short keys plus the legacy long spellings (backward compat).
			const resolvedConfig = resolveAgentInvocationConfig(customConfig, {
				model: params.model as string | undefined,
				thinking: params.thinking as string | undefined,
				turns: params.turns as number | undefined,
				// Legacy spelling — read via the loose view since the schema dropped it.
				max_turns: looseParams.max_turns as number | undefined,
			});

			// Resolve model — ALWAYS compute modelName (the pix twist)
			let model = ctx.model;
			let modelName: string | undefined;
			if (resolvedConfig.modelInput) {
				const resolved = resolveModel(resolvedConfig.modelInput, ctx.modelRegistry);
				if (typeof resolved === "string") {
					// Model not found — return error to planner so it can re-pick
					if (resolvedConfig.modelFromParams) return textResult(resolved);
					// Config-specified but unavailable: silent fallback to parent
				} else {
					model = resolved;
				}
			}
			// Always set modelName (the twist: visible even when same as parent)
			if (model) modelName = shortModelLabel(model);

			// Mentor guard: reject when the chosen model is weaker than the parent
			// OR when benchmark data is missing (can't verify it meets the floor).
			// Equal or higher scores are allowed — same-tier calls (e.g. Opus → Opus)
			// are useful for a second perspective on critical decisions.
			if (subagentType === "Mentor" && model && ctx.model) {
				const childBench = lookupBenchmark(model.id);
				const parentBench = lookupBenchmark(ctx.model.id);
				const childScore = childBench?.overallScore ?? null;
				const parentScore = parentBench?.overallScore ?? null;
				if (childScore == null || parentScore == null) {
					const missing = [
						childScore == null ? `"${modelName}"` : "",
						parentScore == null ? "current model" : "",
					]
						.filter(Boolean)
						.join(" and ");
					return textResult(
						`Cannot verify Mentor model is at least as capable as the parent — no benchmark score for ${missing}. ` +
							`Pick a model with a known ⚡ score from the available models list so the guard can verify it.`,
					);
				}
				if (childScore < parentScore) {
					return textResult(
						`Mentor model "${modelName}" (⚡${childScore}) is weaker than the current model (⚡${parentScore}). ` +
							`Mentor requires a model at least as capable as the parent (⚡${parentScore}+) — pick one from the available models list.`,
					);
				}
			}

			const thinking = resolvedConfig.thinking;
			const inheritContext = resolvedConfig.inheritContext;
			const isolated = resolvedConfig.isolated;
			const effectiveMaxTurns = normalizeMaxTurns(resolvedConfig.maxTurns);

			// Build invocation snapshot (for widget + notification)
			const agentInvocation: AgentInvocation = {
				modelName, // always set
				thinking,
				maxTurns: effectiveMaxTurns,
				isolated,
				inheritContext,
			};

			const detailBase = {
				displayName,
				description: params.description as string,
				subagentType,
				modelName, // pix twist: always pass through
				tags: [] as string[],
			};

			// Surface any config-load warnings (e.g. invalid thinking level)
			if (customConfig?.warnings?.length) {
				for (const w of customConfig.warnings) detailBase.tags.push(w);
			}

			if (fellBack) detailBase.tags.push("(unknown type → general)");
			if (thinking) detailBase.tags.push(`thinking: ${thinking}`);
			if (isolated) detailBase.tags.push("isolated");

			// Resume existing agent
			if (params.resume) {
				const existing = manager.getRecord(params.resume as string);
				if (!existing)
					return textResult(`Agent not found: "${params.resume}". It may have been cleaned up.`);
				if (!existing.session)
					return textResult(`Agent "${params.resume}" has no active session to resume.`);
				const record = await manager.resume(
					params.resume as string,
					params.prompt as string,
					signal,
				);
				if (!record) return textResult(`Failed to resume agent "${params.resume}".`);
				return textResult(
					record.result?.trim() || record.error?.trim() || "No output.",
					buildDetails(detailBase, record),
				);
			}

			// Validate + build allowed_tools list
			const rawAllowed = params.allowed_tools as string[] | undefined;
			let allowedToolNames: string[] | undefined;
			if (rawAllowed) {
				const knownSet = new Set([...BUILTIN_TOOL_NAMES]);
				const unknown = rawAllowed.filter((t) => !knownSet.has(t));
				// Warn about unknown names but proceed with the valid subset
				const valid = rawAllowed.filter((t) => knownSet.has(t));
				if (unknown.length > 0) {
					const note = `(unknown tool names ignored: ${unknown.join(", ")})`;
					detailBase.tags.push(note);
				}
				allowedToolNames = valid.length > 0 ? valid : undefined;
			}

			const isBackground = runsInBackground(params.background);

			if (isBackground) {
				// ── Background mode: spawn and return immediately ──────────
				const { state: bgState, callbacks: bgCallbacks } = createActivityTracker(
					effectiveMaxTurns,
					() => {
						agentActivity.set(bgId, bgState);
					},
				);

				let bgId: string;
				try {
					bgId = manager.spawn(pi, ctx, subagentType, params.prompt as string, {
						description: params.description as string,
						model,
						maxTurns: effectiveMaxTurns,
						isolated,
						inheritContext,
						thinkingLevel: thinking,
						isBackground: true,
						invocation: agentInvocation,
						// Intentionally no `signal` here: the tool-call signal is aborted
						// when the parent turn ends, which would kill the background agent
						// prematurely — bg agents are meant to outlive the spawning turn.
						allowedToolNames,
						...bgCallbacks,
					});
				} catch (err) {
					return textResult(err instanceof Error ? err.message : String(err));
				}

				agentActivity.set(bgId, bgState);

				// Mark as user-initiated background so the widget lingers the
				// finished line (foreground results show inline in transcript).
				const bgRecord = manager.getRecord(bgId);
				if (bgRecord) bgRecord.isBackground = true;

				return textResult(
					`Agent launched (ID: ${bgId}). Its result will be delivered automatically when it finishes — do NOT poll or sleep-wait. Continue with other work or respond to the user.`,
					{
						...detailBase,
						toolUses: 0,
						context: "",
						durationMs: 0,
						status: "background",
						agentId: bgId,
					},
				);
			}

			// ── Foreground mode (background: false): await inline with streaming progress ──
			let fgSpinnerFrame = 0;
			const fgStartedAt = Date.now();
			const fgUpdateInterval = onUpdate
				? setInterval(() => {
						fgSpinnerFrame++;
						const act = agentActivity.get(fgId);
						const activity = act
							? describeActivity(act.activeTools, act.responseText)
							: "thinking…";
						const contextUsage = act?.session
							? getSessionContextUsage(act.session as SessionLike)
							: null;
						onUpdate({
							content: [{ type: "text" as const, text: "" }],
							details: {
								...detailBase,
								toolUses: act?.toolUses ?? 0,
								context: formatContext(contextUsage),
								outputTokens: act?.lifetimeUsage.output,
								streamingMs: act?.streamingMs,
								durationMs: Date.now() - fgStartedAt,
								status: "running" as const,
								activity,
								spinnerFrame: fgSpinnerFrame,
								turnCount: act?.turnCount,
								maxTurns: act?.maxTurns,
							} satisfies AgentDetails,
						});
					}, 80)
				: undefined;

			const { state: fgState, callbacks: fgCallbacks } = createActivityTracker(
				effectiveMaxTurns,
				() => {
					agentActivity.set(fgId, fgState);
				},
			);

			let fgId: string;
			try {
				fgId = manager.spawn(pi, ctx, subagentType, params.prompt as string, {
					description: params.description as string,
					model,
					maxTurns: effectiveMaxTurns,
					isolated,
					inheritContext,
					thinkingLevel: thinking,
					// Keep the manager record foreground so the widget does not render
					// a second status line while this blocking tool call streams inline.
					isBackground: false,
					invocation: agentInvocation,
					signal, // foreground: parent abort kills the agent
					allowedToolNames,
					...fgCallbacks,
				});
			} catch (err) {
				if (fgUpdateInterval) clearInterval(fgUpdateInterval);
				return textResult(err instanceof Error ? err.message : String(err));
			}

			agentActivity.set(fgId, fgState);

			// Emit initial partial so renderResult shows the live line immediately
			if (onUpdate) {
				onUpdate({
					content: [{ type: "text" as const, text: "" }],
					details: {
						...detailBase,
						toolUses: 0,
						context: "",
						durationMs: 0,
						status: "running" as const,
						activity: "starting…",
						spinnerFrame: 0,
						turnCount: 0,
						maxTurns: effectiveMaxTurns,
					} satisfies AgentDetails,
				});
			}

			// Await the agent's promise — this blocks the tool call until the agent finishes
			const record = manager.getRecord(fgId);
			if (record?.promise) {
				await record.promise;
			}

			if (fgUpdateInterval) clearInterval(fgUpdateInterval);

			// Suppress the completion notification — result is returned inline
			const finalRecord = manager.getRecord(fgId);
			if (finalRecord) finalRecord.resultConsumed = true;

			agentActivity.delete(fgId);

			const resultText = finalRecord?.result?.trim() || finalRecord?.error?.trim() || "No output.";

			return textResult(
				resultText,
				buildDetails(
					detailBase,
					finalRecord ?? {
						toolUses: 0,
						startedAt: Date.now(),
						status: "error",
						lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
					},
					fgState,
				),
			);
		},
	});
}

/**
 * Background is the safe default: parent work can continue while an independent
 * child runs. Only an explicit `false` opts into the blocking inline-result path.
 */
export function runsInBackground(background: unknown): boolean {
	return background !== false;
}

/**
 * Read the agent-type name from renderCall args, accepting the new `type` key
 * and the legacy `subagent_type` spelling. Returns undefined if neither is set.
 */
function resolveTypeName(args: Record<string, unknown>): string | undefined {
	const t = args.type;
	if (typeof t === "string" && t) return t;
	const legacy = args.subagent_type;
	if (typeof legacy === "string" && legacy) return legacy;
	return undefined;
}

// ── agent_result tool ────────────────────────────────────────────────────────

export function createAgentResultTool(
	manager: AgentManager,
	agentActivity: Map<string, AgentActivity>,
) {
	return defineTool({
		name: SUBAGENT_TOOL_NAMES.GET_RESULT,
		label: "Agent Result",
		renderShell: "self",
		description:
			"Retrieve a previous agent result by ID. Results are delivered automatically; do not use this to wait or poll. verbose=true returns full conversation history. turns=N returns only the last N turns — also works for agents stopped or aborted mid-task.",
		parameters: Type.Object({
			agent_id: Type.String({
				description: "The agent ID returned by the agent tool.",
			}),
			verbose: Type.Optional(
				Type.Boolean({
					description:
						"true = full conversation history; false (default) = latest assistant text only.",
				}),
			),
			turns: Type.Optional(
				Type.Number({
					description:
						"Return only the last N turns (assistant + tool activity). Takes precedence over verbose. Useful for recovering partial work from a terminated agent.",
					minimum: 1,
				}),
			),
		}),

		renderCall(args, theme, renderCtx) {
			const text = new Text("", 0, 0);
			if (
				hideCollapsedToolCall(renderCtx.state as CollapseState, renderCtx.expanded, (value) =>
					text.setText(value),
				)
			)
				return text;
			text.setText(
				theme.fg("toolTitle", theme.bold("agent_result ")) +
					theme.fg("accent", args.agent_id as string),
			);
			return text;
		},

		renderResult(result, { expanded }, theme, renderCtx) {
			return renderAgentUtilityResult(result, expanded, theme, renderCtx);
		},

		async execute(_toolCallId, params) {
			const id = params.agent_id as string;
			const record = manager.getRecord(id);
			if (!record) {
				return textResult(
					`Agent not found: "${id}". It may have been cleaned up or the ID is wrong.`,
					{
						_type: "agent-result",
						agentId: id,
						status: "not-found",
						verbose: params.verbose === true,
						hasOutput: false,
					},
				);
			}

			// Suppress the pending completion nudge (agent_result consumed it)
			record.resultConsumed = true;

			const turns =
				typeof params.turns === "number" && Number.isFinite(params.turns) && params.turns >= 1
					? Math.floor(params.turns)
					: undefined;
			if (turns != null && record.session) {
				const text = getAgentLastTurns(record.session, turns) || "No conversation history yet.";
				return textResult(text, {
					_type: "agent-result",
					agentId: id,
					status: record.status,
					verbose: false,
					turns,
					hasOutput: text !== "No conversation history yet.",
				});
			}

			if (params.verbose && record.session) {
				const convo = getAgentConversation(record.session);
				const text = convo || "No conversation history yet.";
				return textResult(text, {
					_type: "agent-result",
					agentId: id,
					status: record.status,
					verbose: true,
					hasOutput: Boolean(convo),
				});
			}

			const activity = agentActivity.get(id);
			const output =
				record.status === "running" ? activity?.responseText?.trim() : record.result?.trim();
			const text =
				output ||
				(record.status === "running"
					? "Agent is still running. No output yet."
					: record.error?.trim() || "No output.");
			return textResult(text, {
				_type: "agent-result",
				agentId: id,
				status: record.status,
				verbose: false,
				hasOutput: Boolean(output),
			});
		},
	});
}

// ── agent_steer tool (polymorphic: steer | stop) ────────────────────────────

export function createAgentSteerTool(manager: AgentManager) {
	return defineTool({
		name: SUBAGENT_TOOL_NAMES.STEER,
		label: "Steer Agent",
		renderShell: "self",
		description:
			"Redirect or stop a running agent. steer delivers a message after its current tool call; stop aborts it immediately.",
		parameters: Type.Object({
			agent_id: Type.String({ description: "The agent ID to steer or stop." }),
			action: Type.Optional(
				Type.Enum(["steer", "stop"] as const, {
					type: "string",
					description:
						'Required choice when provided. Enter exactly "steer" (default) to redirect with a message or "stop" to force-kill immediately.',
					default: "steer",
				}),
			),
			message: Type.Optional(
				Type.String({
					description:
						"The steering message to inject. Required for action='steer', ignored for action='stop'.",
				}),
			),
		}),

		renderCall(args, theme, renderCtx) {
			const text = new Text("", 0, 0);
			if (
				hideCollapsedToolCall(renderCtx.state as CollapseState, renderCtx.expanded, (value) =>
					text.setText(value),
				)
			)
				return text;
			const action = (args.action as string) || "steer";
			const label = action === "stop" ? "agent_stop" : "agent_steer";
			text.setText(
				theme.fg("toolTitle", theme.bold(`${label} `)) +
					theme.fg(action === "stop" ? "error" : "accent", args.agent_id as string),
			);
			return text;
		},

		renderResult(result, { expanded }, theme, renderCtx) {
			return renderAgentUtilityResult(result, expanded, theme, renderCtx);
		},

		async execute(_toolCallId, params) {
			const id = params.agent_id as string;
			const action = ((params.action as string) || "steer") as "steer" | "stop";
			const details = (outcome: AgentSteerResultDetails["outcome"]): AgentSteerResultDetails => ({
				_type: "agent-steer",
				agentId: id,
				action,
				outcome,
			});
			const record = manager.getRecord(id);
			if (!record) return textResult(`Agent not found: "${id}".`, details("not-found"));

			// ── stop action: force-abort immediately ──────────────────
			if (action === "stop") {
				const stopped = manager.abort(id);
				if (!stopped) {
					// Already finished — return whatever result it produced
					const existing = record.result ?? "";
					return textResult(
						`Agent "${id}" is not running (status: ${record.status}).${existing ? `\nPartial output:\n${existing}` : ""}`,
						details("already-finished"),
					);
				}

				// Wait briefly for the session to flush its partial response text
				// into record.result (the .then() handler runs async after abort).
				await new Promise((r) => setTimeout(r, 200));

				const partial = record.result ?? "";
				const lines = [
					`Agent "${id}" stopped.`,
					partial
						? `Partial output saved. Use agent_result("${id}") to retrieve it.`
						: "No output was captured before the agent was stopped.",
				];
				return textResult(lines.join("\n"), details("stopped"));
			}

			// ── steer action: inject message ──────────────────────────
			const message = params.message as string | undefined;
			if (!message) {
				return textResult(
					"Missing required 'message' parameter for steer action.",
					details("invalid"),
				);
			}

			if (record.session) {
				try {
					await record.session.steer(message);
					return textResult(`Steering message delivered to agent "${id}".`, details("delivered"));
				} catch (err) {
					return textResult(
						`Failed to steer agent: ${err instanceof Error ? err.message : String(err)}`,
						details("error"),
					);
				}
			}

			// Session not ready yet — queue the steer
			if (!record.pendingSteers) record.pendingSteers = [];
			record.pendingSteers.push(message);
			return textResult(
				`Agent "${id}" session not yet ready. Steer queued and will be delivered on session start.`,
				details("queued"),
			);
		},
	});
}

// ── shared helpers ───────────────────────────────────────────────────────────

/**
 * Create an AgentActivity state and spawn callbacks for tracking tool usage.
 *
 * `onWarning` pushes messages into `state.warnings` and triggers a stream update.
 * The fg path surfaces warnings via `detailBase.tags` when building final details;
 * bg agents store warnings on the state but don't surface them via notifications —
 * the notification path doesn't carry tags, and retrofitting it is non-trivial.
 * Fg-only surfacing is acceptable: bg warnings are rare config errors that also
 * appear in the parent's agent config diagnostics.
 */
function createActivityTracker(maxTurns?: number, onStreamUpdate?: () => void) {
	const state: AgentActivity & { durationMs: number; warnings: string[] } = {
		activeTools: new Map(),
		toolUses: 0,
		turnCount: 0,
		maxTurns,
		responseText: "",
		session: undefined,
		lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
		streamingMs: 0,
		durationMs: 0,
		warnings: [],
	};
	const startedAt = Date.now();
	let streamStart: number | null = null;

	const callbacks = {
		onWarning: (message: string) => {
			state.warnings.push(message);
			onStreamUpdate?.();
		},
		onToolActivity: (activity: { type: "start" | "end"; toolName: string }) => {
			if (activity.type === "start") {
				state.activeTools.set(`${activity.toolName}_${Date.now()}`, activity.toolName);
			} else {
				for (const [key, name] of state.activeTools) {
					if (name === activity.toolName) {
						state.activeTools.delete(key);
						break;
					}
				}
				state.toolUses++;
			}
			onStreamUpdate?.();
		},
		onTextDelta: (_delta: string, fullText: string) => {
			if (streamStart === null) streamStart = Date.now();
			state.responseText = fullText;
			state.durationMs = Date.now() - startedAt;
			onStreamUpdate?.();
		},
		onTurnEnd: (turnCount: number) => {
			state.turnCount = turnCount;
			onStreamUpdate?.();
		},
		onSessionCreated: (session: unknown) => {
			state.session = session as AgentActivity["session"];
		},
		onAssistantUsage: (usage: { input: number; output: number; cacheWrite: number }) => {
			// Finalize the streaming window for this turn.
			if (streamStart !== null) {
				state.streamingMs += Date.now() - streamStart;
				streamStart = null;
			}
			state.lifetimeUsage.input += usage.input;
			state.lifetimeUsage.output += usage.output;
			state.lifetimeUsage.cacheWrite += usage.cacheWrite;
			onStreamUpdate?.();
		},
	};

	return { state, callbacks, getWarnings: () => state.warnings };
}

function buildDetails(
	base: Pick<AgentDetails, "displayName" | "description" | "subagentType" | "modelName" | "tags">,
	record: {
		toolUses: number;
		startedAt: number;
		completedAt?: number;
		status: string;
		error?: string;
		id?: string;
		lifetimeUsage: { input: number; output: number; cacheWrite: number };
	},
	activity?: AgentActivity & { durationMs?: number },
): AgentDetails {
	const contextUsage = activity?.session
		? getSessionContextUsage(activity.session as SessionLike)
		: null;
	return {
		...base,
		toolUses: record.toolUses,
		context: formatContext(contextUsage),
		outputTokens: record.lifetimeUsage.output,
		streamingMs: activity?.streamingMs,
		turnCount: activity?.turnCount,
		maxTurns: activity?.maxTurns,
		durationMs: activity?.durationMs ?? (record.completedAt ?? Date.now()) - record.startedAt,
		status: record.status as AgentDetails["status"],
		agentId: record.id,
		error: record.error,
	};
}
