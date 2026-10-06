import { Text } from "@earendil-works/pi-tui";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import {
	COLLAPSED_TOOL_GLYPH,
	dotJoin,
	formatCollapsedToolRow,
	frameToolResult,
	padIcon,
} from "@xynogen/pix-pretty/utils";
import {
	formatMs,
	formatSpeed,
	formatToolUses,
	formatTurns,
	SPINNER,
} from "@xynogen/pix-pretty/widget-format";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";
import { SUBAGENT_TOOL_NAMES } from "./agent-runner.ts";
import { getConfig } from "./agent-types.ts";
import type {
	AgentDetails,
	AgentInfoResultDetails,
	AgentUtilityResultDetails,
	Theme,
} from "./types.ts";

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
// ponytail: type and model catalogs still parse execute() text. Active agents use details. If the
// execute() line format changes, update the split logic here. Ceiling: a format
// drift degrades to a dim raw line, never crashes. Upgrade path: have execute()
// return structured rows in `details` instead of a joined string.

/** `info active` — one row per agent: <mark> <id> <type>[model] · <desc>. */
function formatInfoActive(details: AgentInfoResultDetails, theme: Theme): string {
	const rows = details.rows ?? [];
	const out = [utilityHeading("Agents", details.count, theme)];
	if (rows.length === 0) out.push(theme.fg("muted", "  (none)"));
	for (const row of rows) {
		const model = row.modelName ? ` ${theme.fg("muted", `[${row.modelName}]`)}` : "";
		const head = dotJoin(
			[
				`${statusMark(row.status, theme)} ${theme.fg("dim", row.id)} ${theme.fg("toolTitle", row.type)}${model}`,
				row.description ? theme.fg("muted", row.description) : "",
			],
			(s) => theme.fg("muted", s),
		);
		out.push(`  ${head}`);
	}
	if (details.guidance) out.push("", theme.fg("muted", `  ${details.guidance}`));
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
				? formatInfoActive(details, theme)
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

export function renderAgentUtilityResult(
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
