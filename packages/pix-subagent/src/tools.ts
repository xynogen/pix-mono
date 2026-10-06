/**
 * tools.ts — The 4 LLM-callable tool definitions:
 *   agent          — spawn a sub-agent (fg or bg)
 *   agent_control  — discover, inspect, steer, or stop agents
 *
 * Design notes:
 * - volatile model/type catalogs live behind agent_control, not the agent schema.
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

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { lookupBenchmark } from "@xynogen/pix-data";
import { commandPreview } from "@xynogen/pix-pretty/command-preview";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import {
	COLLAPSED_TOOL_GLYPH,
	dotJoin,
	formatCollapsedToolRow,
	formatToolCallTitle,
	frameToolResult,
	getErrorMessage,
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
import { agentDir } from "@xynogen/pix-runtime/paths";
import { Type } from "typebox";
import { type AgentManager, DEFAULT_MAX_RETAINED } from "./agent-manager.ts";
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
	// Shared grammar: `<tool> <target> · <call metadata>` — tool is the registered
	// name `agent`, target is the agent display name.
	const head = `${theme.fg("toolTitle", theme.bold("agent"))} ${theme.fg("dim", displayName)}${modelStr}`;
	const header = description
		? dotJoin([head, theme.fg("dim", description)], (s) => theme.fg("muted", s))
		: head;

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

/** Split `s` on the first occurrence of `sep`; the separator is discarded. */
function splitFirst(s: string, sep: string): [string, string] {
	const i = s.indexOf(sep);
	return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + sep.length)];
}

/** Colored, width-normalized status marker shared by every expanded utility row. */
function statusMark(status: string, theme: Theme): string {
	switch (status) {
		case "completed":
		case "steered":
		case "delivered":
		case "success":
			return theme.fg("success", padIcon(icon("status.ok")));
		case "running":
		case "queued":
		case "background":
			return theme.fg("accent", padIcon(icon("status.running")));
		case "stopped":
			return theme.fg("muted", padIcon("■"));
		case "aborted":
		case "warning":
		case "already-finished":
			return theme.fg("warning", padIcon(icon("status.warn")));
		default: // error, not-found, invalid
			return theme.fg("error", padIcon(icon("status.error")));
	}
}

/** `● Agents · 3` heading built from details (label + count). */
function utilityHeading(label: string, count: number, theme: Theme): string {
	return `${theme.fg("accent", icon("status.active"))} ${theme.fg("toolTitle", theme.bold(label))} ${theme.fg("muted", `· ${count}`)}`;
}

// ── expanded pretty renderers ────────────────────────────────────────────────
// ponytail: these reparse the plain text emitted by the tools' execute(); if the
// execute() line format changes, update the split logic here. Ceiling: a format
// drift degrades to a dim raw line, never crashes. Upgrade path: have execute()
// return structured rows in `details` instead of a joined string.

/** `info active` — one row per agent: <mark> <id> <type>[model] · <desc>. */
function formatInfoActive(text: string, count: number, theme: Theme): string {
	const raw = text.split("\n");
	const guidance = raw.filter((l) => l.trim()).pop();
	const headingIdx = raw.findIndex((l) => l.trimEnd().endsWith(":"));
	const dataLines = raw.slice(headingIdx + 1).filter((l) => l.trim() && l !== guidance);
	const out = [utilityHeading("Agents", count, theme)];
	for (const line of dataLines) {
		if (line.trim() === "(none)") {
			out.push(theme.fg("muted", "  (none)"));
			continue;
		}
		const [id, rest] = splitFirst(line, "  — ");
		if (!rest) {
			out.push(theme.fg("dim", `  ${line.trim()}`));
			continue;
		}
		const segs = rest.split(" · ");
		const status = segs[0]?.trim() ?? "";
		const typeModel = segs[1] ?? "";
		const desc = segs.slice(2).join(" · ");
		const mm = typeModel.match(/^(.*?)\s*(\[[^\]]*\])?\s*$/);
		const type = mm?.[1]?.trim() ?? typeModel.trim();
		const model = mm?.[2] ?? "";
		const head = dotJoin(
			[
				`${statusMark(status, theme)} ${theme.fg("dim", id.trim())} ${theme.fg("toolTitle", type)}${model ? ` ${theme.fg("muted", model)}` : ""}`,
				desc ? theme.fg("muted", desc) : "",
			],
			(s) => theme.fg("muted", s),
		);
		out.push(`  ${head}`);
	}
	if (guidance) out.push("", theme.fg("muted", `  ${guidance}`));
	return out.join("\n");
}

/** `info types` — <name> <tools> · <desc>. */
function formatInfoTypes(text: string, count: number, theme: Theme): string {
	const raw = text.split("\n");
	const guidance = raw.filter((l) => l.trim()).pop();
	const headingIdx = raw.findIndex((l) => l.trimEnd().endsWith(":"));
	const dataLines = raw.slice(headingIdx + 1).filter((l) => l.trim().startsWith("-"));
	const out = [utilityHeading("Agent types", count, theme)];
	for (const line of dataLines) {
		const body = line.replace(/^\s*-\s*/, "");
		const ci = body.indexOf(": ");
		const name = ci < 0 ? body : body.slice(0, ci);
		const rest = ci < 0 ? "" : body.slice(ci + 2);
		const tm = rest.match(/\s*\(tools:([^)]*)\)\s*$/);
		const tools = tm?.[1] ?? "";
		const desc = tm ? rest.slice(0, tm.index).trim() : rest.trim();
		out.push(
			`  ${dotJoin(
				[
					`${theme.fg("toolTitle", name)}${tools ? ` ${theme.fg("dim", tools)}` : ""}`,
					desc ? theme.fg("muted", desc) : "",
				],
				(s) => theme.fg("muted", s),
			)}`,
		);
	}
	if (guidance) out.push("", theme.fg("muted", `  ${guidance}`));
	return out.join("\n");
}

/** `info models` — parent line + <id> — <meta>. */
function formatInfoModels(text: string, count: number, theme: Theme): string {
	const raw = text.split("\n");
	const guidance = raw.filter((l) => l.trim()).pop();
	const parentLine = raw.find((l) => l.startsWith("Current parent:"));
	const headingIdx = raw.findIndex((l) => l.trimEnd().endsWith(":"));
	const dataLines = raw
		.slice(headingIdx + 1)
		.filter((l) => l.trim() && l !== guidance && !l.startsWith("Current parent:"));
	const out = [utilityHeading("Models", count, theme)];
	if (parentLine) {
		const val = parentLine.slice("Current parent:".length).trim();
		out.push(`  ${theme.fg("muted", "parent:")} ${theme.fg("dim", val)}`);
	}
	for (const line of dataLines) {
		if (line.trim() === "(none)") {
			out.push(theme.fg("muted", "  (none)"));
			continue;
		}
		const [id, meta] = splitFirst(line, "  — ");
		out.push(`  ${theme.fg("dim", id.trim())}${meta ? ` ${theme.fg("muted", `— ${meta}`)}` : ""}`);
	}
	if (guidance) out.push("", theme.fg("muted", `  ${guidance}`));
	return out.join("\n");
}

/** `result`/`steer`/`stop` — colored header row + dim, indented body. */
function formatUtilityAction(
	verb: string,
	agentId: string,
	statusWord: string,
	meta: string,
	body: string,
	theme: Theme,
): string {
	const header = dotJoin(
		[
			`${statusMark(statusWord, theme)} ${theme.fg("toolTitle", theme.bold("agent_control"))} ${theme.fg("dim", `${verb} ${agentId}`)}`,
			meta ? theme.fg("muted", meta) : "",
		],
		(s) => theme.fg("muted", s),
	);
	const bodyLines = body
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => theme.fg("dim", `  ${l}`));
	return [header, ...bodyLines].join("\n");
}

/** Pick the pretty expanded body + error flag for one utility result. */
function renderExpandedUtility(
	details: AgentUtilityResultDetails,
	text: string,
	theme: Theme,
	ctxIsError: boolean,
): { pretty?: string; isError?: boolean } {
	if (details._type === "agent-info") {
		const pretty =
			details.kind === "active"
				? formatInfoActive(text, details.count, theme)
				: details.kind === "types"
					? formatInfoTypes(text, details.count, theme)
					: formatInfoModels(text, details.count, theme);
		return { pretty, isError: ctxIsError };
	}
	if (details._type === "agent-result") {
		let isError: boolean | undefined;
		if (details.status === "completed" || details.status === "steered") isError = false;
		else if (details.status === "error" || details.status === "not-found") isError = true;
		else if ((details.status === "aborted" || details.status === "stopped") && ctxIsError)
			isError = true;
		const meta =
			details.status === "not-found"
				? "not found"
				: details.turns != null
					? `last ${details.turns} turn${details.turns === 1 ? "" : "s"}`
					: details.status;
		return {
			pretty: formatUtilityAction("result", details.agentId, details.status, meta, text, theme),
			isError,
		};
	}
	let isError: boolean | undefined;
	if (details.outcome === "delivered") isError = false;
	else if (
		details.outcome === "not-found" ||
		details.outcome === "invalid" ||
		details.outcome === "error"
	)
		isError = true;
	else if ((details.outcome === "stopped" || details.outcome === "already-finished") && ctxIsError)
		isError = true;
	let meta: string = details.outcome;
	if (details.outcome === "stopped") {
		if (text.includes("Partial output saved")) meta = "partial output saved";
		else if (text.includes("summarize its progress")) meta = "summarizing progress";
	} else if (details.outcome === "already-finished") meta = "already finished";
	else if (details.outcome === "not-found") meta = "not found";
	return {
		pretty: formatUtilityAction(
			details.action,
			details.agentId,
			details.outcome,
			meta,
			text,
			theme,
		),
		isError,
	};
}

function renderAgentUtilityResult(
	result: { content: { type: string; text?: string }[]; details?: unknown },
	expanded: boolean,
	isPartial: boolean,
	theme: Theme,
	renderCtx: {
		state: Record<string, unknown>;
		invalidate: () => void;
		isError?: boolean;
	},
) {
	const details = result.details as AgentUtilityResultDetails | undefined;
	const text = resultText(result);
	const component = new Text(text, 0, 0);
	if (isPartial) return component;
	if (!details) {
		if (expanded && renderCtx.isError === true) return frameToolResult(component, theme, true);
		return component;
	}
	const collapseTool = SUBAGENT_TOOL_NAMES.CONTROL;
	const collapsed = tickCollapse(
		collapseTool,
		renderCtx.state as CollapseState,
		renderCtx.invalidate,
		expanded,
	);

	if (!collapsed) {
		const { pretty, isError } = renderExpandedUtility(
			details,
			text,
			theme,
			renderCtx.isError === true,
		);
		const view = pretty ? new Text(pretty, 0, 0) : component;
		return isError == null ? view : frameToolResult(view, theme, isError);
	}

	if (details._type === "agent-info") {
		return new Text(
			formatCollapsedToolRow(
				theme,
				SUBAGENT_TOOL_NAMES.CONTROL,
				details.query ? `info ${details.kind} “${details.query}”` : `info ${details.kind}`,
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
			SUBAGENT_TOOL_NAMES.CONTROL,
			`result ${details.agentId}`,
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

	const tool = SUBAGENT_TOOL_NAMES.CONTROL;
	const target = `${details.action} ${details.agentId}`;
	let meta: string = details.outcome;
	if (details.outcome === "stopped") {
		if (text.includes("Partial output saved")) meta = "partial output saved";
		else if (text.includes("summarize its progress")) meta = "summarizing progress";
	} else if (details.outcome === "already-finished") meta = "already finished";
	else if (details.outcome === "not-found") meta = "not found";
	if (details.outcome === "stopped") {
		const row = formatCollapsedToolRow(theme, tool, target, meta);
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
	return new Text(formatCollapsedToolRow(theme, tool, target, meta, status), 0, 0);
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
	if (d.tags) parts.push(...d.tags.map((t) => theme.fg("muted", t)));
	if (d.turnCount != null && d.turnCount > 0)
		parts.push(theme.fg("muted", formatTurns(d.turnCount, d.maxTurns)));
	if (d.toolUses > 0) parts.push(theme.fg("muted", formatToolUses(d.toolUses)));
	if (d.context) parts.push(theme.fg("muted", d.context));
	return dotJoin(parts, (s) => theme.fg("muted", s));
}

/** Format a live agent row with stable identity-first ordering. */
export function formatAgentRunningLine(d: AgentDetails, theme: Theme): string {
	const frame = d.spinnerFrame != null ? (SPINNER[d.spinnerFrame % SPINNER.length] ?? "⠋") : "⠋";
	const modelLabel = d.modelName ? ` ${theme.fg("muted", `[${d.modelName}]`)}` : "";
	const parts: string[] = [];
	if (d.turnCount != null && d.turnCount > 0) parts.push(formatTurns(d.turnCount, d.maxTurns));
	if (d.toolUses > 0) parts.push(formatToolUses(d.toolUses));
	if (d.context) parts.push(d.context);
	const speed = formatSpeed(d.outputTokens ?? 0, d.streamingMs ?? 0);
	if (speed) parts.push(speed);
	if (d.durationMs > 0) parts.push(formatMs(d.durationMs));
	const dot = (s: string) => theme.fg("muted", s);
	return dotJoin(
		[
			`  ${theme.fg("accent", frame)} ${theme.fg("toolTitle", theme.bold(d.displayName))}${modelLabel}`,
			theme.fg("dim", d.description),
			parts.length > 0 ? theme.fg("muted", dotJoin(parts)) : "",
			d.activity ? theme.fg("dim", d.activity) : "",
		],
		dot,
	);
}

/** Format every terminal state with stable identity-first ordering. */
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
			marker = theme.fg("muted", padIcon("■"));
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
	if (d.description) parts.push(theme.fg("dim", d.description));
	const stats = buildStats(d, theme);
	if (stats) parts.push(stats);
	const speed = formatSpeed(d.outputTokens ?? 0, d.streamingMs ?? d.durationMs);
	if (speed) parts.push(theme.fg("muted", speed));
	parts.push(theme.fg("muted", formatMs(d.durationMs)));
	let statusColor: "error" | "muted" | "success" = "success";
	if (d.status === "error") statusColor = "error";
	else if (d.status === "stopped") statusColor = "muted";
	parts.push(theme.fg(statusColor, status));

	const dot = (s: string) => theme.fg("muted", s);
	// Lead with the registered tool name `agent`, then the agent display name as
	// the target — matching the call row and every other collapsed tool row.
	const identity = `${marker} ${theme.fg("toolTitle", theme.bold("agent"))} ${theme.fg("dim", d.displayName)}`;
	return dotJoin([identity, ...parts], dot);
}

/** Backward-compatible name for completed-row consumers. */
export function formatAgentCompletedLine(d: AgentDetails, theme: Theme): string {
	return formatAgentFinishedLine(d, theme);
}

// ── compact tool description + on-demand discovery ──────────────────────────

export function buildAgentToolDescription(): string {
	return "Launch a sub-agent only for delegated work; use direct tools for known tasks. Call agent_control(action:'info') to discover types, models, or active IDs. Keep prompts self-contained and never fork/inherit parent context. Use thinking medium or high; anything above high requires prior user approval after a concrete benefit and cost/latency justification. Omit model to inherit the parent model.";
}

export function agentTypeGuidance(): string {
	return `Pass one type name to agent.type. Custom agents: .pi/agents/*.md or ${agentDir()}/agents/*.md (project overrides global).`;
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

export function createAgentInfoTool(reloadCustomAgents: () => void, manager?: AgentManager) {
	return defineTool({
		name: "agent_info",
		label: "Agent Info",
		renderShell: "self",
		description:
			"List runtime agent types, available models, or agent IDs (running plus retained finished).",
		parameters: Type.Object({
			kind: Type.Enum(["types", "models", "active"] as const, {
				type: "string",
				description:
					'Catalog: "types" = roles/tools; "models" = available models; "active" = agent IDs (running/queued plus retained finished, so completed IDs stay recoverable).',
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
			text.setText(`${formatToolCallTitle(theme, "agent_info", renderCtx)} ${kind}${query}`);
			return text;
		},

		renderResult(result, { expanded, isPartial }, theme, renderCtx) {
			return renderAgentUtilityResult(result, expanded, isPartial, theme, renderCtx);
		},

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const query = params.query as string | undefined;
			const limit = boundedLimit(params.limit);
			if (params.kind === "types") reloadCustomAgents();
			let lines: string[];
			let heading: string;
			let guidance: string;
			let parent = "";
			if (params.kind === "models") {
				lines = listAgentModels(ctx.modelRegistry, query, limit);
				heading = "Available models";
				guidance =
					"Pass provider/id or a fuzzy name to agent.model; omit model to inherit the parent.";
				parent = `Current parent: ${describeParentModel(ctx.modelRegistry, ctx.model)}\n\n`;
			} else if (params.kind === "active") {
				const needle = normalizeQuery(query);
				// Show running/queued first, then retained finished agents (still in the
				// ring buffer) so their IDs stay recoverable for agent_control result.
				const rank = (s: string) => (s === "running" || s === "queued" ? 0 : 1);
				lines = (manager?.listAgents() ?? [])
					.sort((a, b) => rank(a.status) - rank(b.status))
					.map((record) => {
						const model = record.invocation?.modelName ? ` [${record.invocation.modelName}]` : "";
						return `${record.id}  — ${record.status} · ${record.type}${model} · ${record.description}`;
					})
					.filter((line) => !needle || line.toLocaleLowerCase().includes(needle))
					.slice(0, limit);
				heading = "Agents";
				guidance = "Pass an ID to agent_control with action steer/stop/result.";
			} else {
				lines = listAgentTypes(query, limit);
				heading = "Available agent types";
				guidance = agentTypeGuidance();
			}
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

// ── agent_control tool ───────────────────────────────────────────────────────

export function createAgentControlTool(
	manager: AgentManager,
	agentActivity: Map<string, AgentActivity>,
	reloadCustomAgents: () => void,
) {
	const info = createAgentInfoTool(reloadCustomAgents, manager);
	const result = createAgentResultTool(manager, agentActivity);
	const steer = createAgentSteerTool(manager);
	return defineTool({
		name: SUBAGENT_TOOL_NAMES.CONTROL,
		label: "Agent Control",
		renderShell: "self",
		description:
			"Inspect agent types/models/active IDs, retrieve output, redirect a running agent, or stop it.",
		parameters: Type.Object({
			action: Type.Enum(["info", "result", "steer", "stop"] as const, {
				type: "string",
				description: "Operation to perform.",
			}),
			kind: Type.Optional(
				Type.Enum(["types", "models", "active"] as const, {
					type: "string",
					description: "For info: catalog to list. Defaults to active.",
				}),
			),
			agent_id: Type.Optional(Type.String({ description: "For result/steer/stop: agent ID." })),
			message: Type.Optional(Type.String({ description: "For steer: instruction to inject." })),
			force: Type.Optional(
				Type.Boolean({
					description:
						"For stop: force-kill immediately instead of the default graceful stop (which asks the agent to summarize its progress first, so partial work isn't lost).",
				}),
			),
			query: Type.Optional(Type.String({ description: "For info: optional text filter." })),
			limit: Type.Optional(
				Type.Number({ description: "For info: max results (default 20, max 50).", minimum: 1 }),
			),
			verbose: Type.Optional(
				Type.Boolean({ description: "For result: return full conversation history." }),
			),
			turns: Type.Optional(
				Type.Number({ description: "For result: return only last N turns.", minimum: 1 }),
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
			const action = String(args.action ?? "info");
			const target =
				action === "info" ? String(args.kind ?? "active") : String(args.agent_id ?? "");
			text.setText(
				`${formatToolCallTitle(theme, "agent_control", renderCtx)} ${theme.fg("dim", action)}${target ? ` ${theme.fg("accent", target)}` : ""}`,
			);
			return text;
		},
		renderResult(result, { expanded, isPartial }, theme, renderCtx) {
			return renderAgentUtilityResult(result, expanded, isPartial, theme, renderCtx);
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (params.action === "info") {
				return info.execute(
					toolCallId,
					{ kind: params.kind ?? "active", query: params.query, limit: params.limit },
					signal,
					onUpdate,
					ctx,
				);
			}
			if (!params.agent_id) return textResult(`Missing required 'agent_id' for ${params.action}.`);
			if (params.action === "result") {
				return result.execute(
					toolCallId,
					{
						agent_id: params.agent_id,
						verbose: params.verbose,
						turns: params.turns,
					},
					signal,
					onUpdate,
					ctx,
				);
			}
			return steer.execute(
				toolCallId,
				{
					agent_id: params.agent_id,
					action: params.action,
					message: params.message,
					force: params.force,
				},
				signal,
				onUpdate,
				ctx,
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
			type: Type.String({
				description: "Agent type; see agent_control(action:'info', kind:'types').",
			}),
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
			if ((renderCtx.state as CollapseState).collapsed && !renderCtx.expanded)
				return new Text("", 0, 0);
			const input = args as Record<string, unknown>;
			const header = formatAgentCall(input, theme, false).replace(
				theme.fg("toolTitle", theme.bold("agent")),
				formatToolCallTitle(theme, "agent", renderCtx),
			);
			if (typeof input.prompt !== "string" || !input.prompt) return new Text(header, 0, 0);
			return commandPreview(
				header,
				input.prompt,
				undefined,
				theme as unknown as { fg: (key: string, text: string) => string },
				renderCtx.state,
				renderCtx.invalidate,
				renderCtx.expanded,
			);
		},

		renderResult(result, { expanded, isPartial }, theme, renderCtx) {
			const details = result.details as AgentDetails | undefined;
			if (!details) {
				const text = result.content[0]?.type === "text" ? result.content[0].text : "";
				const component = new Text(text, 0, 0);
				return isPartial ? component : frameToolResult(component, theme, renderCtx.isError);
			}

			// Streaming / running — show a compact live status line so the model
			// and activity are visible inline in the transcript (the ● Agents
			// widget carries full detail above the editor).
			if (isPartial || details.status === "running" || details.status === "queued") {
				return new Text(formatAgentRunningLine(details, theme), 0, 0);
			}

			// Background launches return before the child completes. While it runs, the
			// ● Agents widget is the one live surface, so this card stays “Launched”.
			// It follows the manager record only to show the finished line.
			if (details.status === "background" && details.agentId) {
				let terminalLine: string | undefined;
				const launchedLine = theme.fg(
					"dim",
					`  ⎿  Launched${details.modelName ? ` ${theme.fg("muted", `[${details.modelName}]`)}` : ""} — result auto-delivered on completion`,
				);
				return {
					render: (width: number) => {
						if (terminalLine) return [truncateToWidth(terminalLine, width)];
						const record = manager.getRecord(details.agentId as string);
						if (!record || record.status === "running" || record.status === "queued")
							return [truncateToWidth(launchedLine, width)];
						const activity = agentActivity.get(record.id);
						const liveDetails = buildDetails(
							{
								displayName: details.displayName,
								description: details.description,
								subagentType: details.subagentType,
								modelName: details.modelName,
								tags: details.tags,
							},
							record,
							activity,
						);
						terminalLine = formatAgentFinishedLine(liveDetails, theme);
						return [truncateToWidth(terminalLine, width)];
					},
					invalidate() {},
				};
			}

			// Collapse only terminal results. Expansion keeps all model-visible output.
			const collapsed = tickCollapse(
				SUBAGENT_TOOL_NAMES.AGENT,
				renderCtx.state as CollapseState,
				renderCtx.invalidate,
				expanded,
			);
			let line = formatAgentFinishedLine(details, theme);
			if (!collapsed) {
				const resultText = result.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n");
				if (resultText) {
					const resultLines = resultText.split("\n");
					for (const resultLine of resultLines) {
						line += `\n${theme.fg("dim", `  ${resultLine}`)}`;
					}
				}
			}
			const component = new Text(line, 0, 0);
			if (collapsed) return component;
			if (details.status === "completed" || details.status === "steered")
				return frameToolResult(component, theme, false);
			if (
				details.status === "error" ||
				((details.status === "aborted" || details.status === "stopped") &&
					renderCtx.isError === true)
			)
				return frameToolResult(component, theme, true);
			return component;
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
					return textResult(
						`Agent not found: "${params.resume}". Only the last ${DEFAULT_MAX_RETAINED} finished agents are kept per session; older ones are evicted.`,
					);
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
					return textResult(getErrorMessage(err));
				}

				agentActivity.set(bgId, bgState);

				// Mark as user-initiated background so the widget lingers the
				// finished line (foreground results show inline in transcript).
				const bgRecord = manager.getRecord(bgId);
				if (bgRecord) bgRecord.isBackground = true;

				return textResult(
					`Launched ${bgId}. To steer or stop it while it runs: agent_control action:"steer"/"stop". ` +
						`Its result is delivered automatically when it finishes — do NOT poll, sleep-wait, or call agent_control just to fetch it. ` +
						`Stop is gentle by default: the agent summarizes its progress first, so partial work is never lost. Continue with other work or respond to the user.`,
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
				return textResult(getErrorMessage(err));
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
		name: "agent_result",
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
				formatToolCallTitle(theme, "agent_result", renderCtx) +
					" " +
					theme.fg("accent", args.agent_id as string),
			);
			return text;
		},

		renderResult(result, { expanded, isPartial }, theme, renderCtx) {
			return renderAgentUtilityResult(result, expanded, isPartial, theme, renderCtx);
		},

		async execute(_toolCallId, params) {
			const id = params.agent_id as string;
			const record = manager.getRecord(id);
			if (!record) {
				return textResult(
					`Agent not found: "${id}". Only the last ${DEFAULT_MAX_RETAINED} finished agents are kept per session (older ones are evicted), or the ID is wrong.`,
					{
						_type: "agent-result",
						agentId: id,
						status: "not-found",
						verbose: params.verbose === true,
						hasOutput: false,
					},
				);
			}

			// Suppress the pending completion nudge (result was consumed)
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
		name: "agent_steer",
		label: "Steer Agent",
		renderShell: "self",
		description:
			"Redirect or stop a running agent. steer delivers a message after its current tool call; stop asks it to summarize its progress and finish (pass force: true to hard-kill immediately instead).",
		parameters: Type.Object({
			agent_id: Type.String({ description: "The agent ID to steer or stop." }),
			action: Type.Optional(
				Type.Enum(["steer", "stop"] as const, {
					type: "string",
					description:
						'Required choice when provided. Enter exactly "steer" (default) to redirect with a message or "stop" to halt it (graceful by default: it summarizes progress first; pass force: true to hard-kill).',
					default: "steer",
				}),
			),
			message: Type.Optional(
				Type.String({
					description:
						"The steering message to inject. Required for action='steer', ignored for action='stop'.",
				}),
			),
			force: Type.Optional(
				Type.Boolean({
					description:
						"For action='stop': force-kill immediately. Default (false) is a graceful stop that asks the agent to summarize its progress first, so partial findings aren't thrown away.",
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
				formatToolCallTitle(theme, label, renderCtx) +
					" " +
					theme.fg(action === "stop" ? "error" : "accent", args.agent_id as string),
			);
			return text;
		},

		renderResult(result, { expanded, isPartial }, theme, renderCtx) {
			return renderAgentUtilityResult(result, expanded, isPartial, theme, renderCtx);
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

			// ── stop action ───────────────────────────────────────────
			if (action === "stop") {
				const force = params.force === true;

				// Graceful stop (default): steer a halt-and-summarize message so the
				// agent wraps up and its final summary still fires back, instead of
				// hard-killing mid-task and losing every partial finding.
				if (!force) {
					const outcome = manager.requestStop(id);
					if (outcome === "not-running") {
						const existing = record.result ?? "";
						return textResult(
							`Agent "${id}" is not running (status: ${record.status}).${existing ? `\nPartial output:\n${existing}` : ""}`,
							details("already-finished"),
						);
					}
					return textResult(
						`Stop requested for agent "${id}" — it will summarize its progress and finish shortly; the summary is delivered automatically. To force-kill instead, retry with force: true.`,
						details("stopped"),
					);
				}

				// Force-kill: abort immediately, keeping only whatever partial text
				// already streamed out.
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
					`Agent "${id}" force-stopped.`,
					partial
						? `Partial output saved. Use agent_control(action: "result", agent_id: "${id}") to retrieve it.`
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
					return textResult(`Failed to steer agent: ${getErrorMessage(err)}`, details("error"));
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
		onAssistantUsage: (
			usage: { input: number; output: number; cacheWrite: number },
			generationMs: number,
		) => {
			// generationMs is the full message_start→message_end window, so t/s
			// (output / streamingMs) includes the reasoning phase. A text-delta-only
			// window made t/s wildly high for thinking models (usage.output counts
			// reasoning tokens).
			state.streamingMs += generationMs;
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
		turnCount?: number;
		maxTurns?: number;
		streamingMs?: number;
		session?: unknown;
	},
	activity?: AgentActivity & { durationMs?: number },
): AgentDetails {
	const session = activity?.session ?? record.session;
	const contextUsage = session ? getSessionContextUsage(session as SessionLike) : null;
	return {
		...base,
		toolUses: record.toolUses,
		context: formatContext(contextUsage),
		outputTokens: record.lifetimeUsage.output,
		streamingMs: activity?.streamingMs ?? record.streamingMs,
		turnCount: activity?.turnCount ?? record.turnCount,
		maxTurns: activity?.maxTurns ?? record.maxTurns,
		durationMs: activity?.durationMs ?? (record.completedAt ?? Date.now()) - record.startedAt,
		status: record.status as AgentDetails["status"],
		agentId: record.id,
		error: record.error,
	};
}
