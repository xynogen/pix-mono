/**
 * widget.ts — pure render for the live BTW above-editor widget.
 *
 * Kept separate from index.ts (which owns job lifecycle + Pi wiring) so the
 * layout is unit-testable without a Pi host, and so registerBtw stays thin.
 * Mirrors pix-subagent's AgentWidget shape (spinner, per-job stats, finished
 * linger, overflow) for a consistent look across pix's concurrent-work UIs.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import {
	type ContextUsageLike,
	describeActivity,
	formatContext,
	formatMs,
	formatSpeed,
	formatToolUses,
	formatTurns,
	SPINNER,
} from "@xynogen/pix-pretty/widget-format";

export type BtwJobStatus = "running" | "completed" | "error" | "stopped";

/** Snapshot of one job the widget needs to render. */
export interface BtwWidgetJob {
	id: number;
	model: string;
	status: BtwJobStatus;
	startedAt: number;
	completedAt?: number;
	activeTools: string[];
	text: string;
	toolUses: number;
	turnCount: number;
	outputTokens: number;
	contextUsage: ContextUsageLike | null;
	error?: string;
}

/** Minimal theme surface the widget uses (matches Pi's Theme). */
export interface WidgetTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

const MAX_WIDGET_LINES = 12;
const FINISHED_LINGER_MS = 5_000;
const ERROR_LINGER_MS = 15_000;
const ERROR_STATUSES = new Set<BtwJobStatus>(["error", "stopped"]);

/** True while a finished job should still linger in the widget. */
export function shouldShowFinished(job: BtwWidgetJob, now: number): boolean {
	if (job.status === "running" || job.completedAt == null) return false;
	const linger = ERROR_STATUSES.has(job.status) ? ERROR_LINGER_MS : FINISHED_LINGER_MS;
	return now - job.completedAt < linger;
}

/** Any job worth painting right now (running or lingering finished). */
export function hasVisibleJobs(jobs: Iterable<BtwWidgetJob>, now: number): boolean {
	for (const job of jobs) {
		if (job.status === "running" || shouldShowFinished(job, now)) return true;
	}
	return false;
}

function statsFor(job: BtwWidgetJob, endMs: number): string {
	const parts: string[] = [];
	if (job.turnCount > 0) parts.push(formatTurns(job.turnCount));
	if (job.toolUses > 0) parts.push(formatToolUses(job.toolUses));
	const ctx = formatContext(job.contextUsage);
	if (ctx) parts.push(ctx);
	const speed = formatSpeed(job.outputTokens, endMs - job.startedAt);
	if (speed) parts.push(speed);
	parts.push(formatMs(endMs - job.startedAt));
	return parts.join(" \u00b7 ");
}

function finishedLine(job: BtwWidgetJob, theme: WidgetTheme): string {
	const end = job.completedAt ?? Date.now();
	let mark: string;
	let suffix = "";
	if (job.status === "completed") {
		mark = theme.fg("success", "\u2713");
	} else if (job.status === "stopped") {
		mark = theme.fg("dim", "\u25a0");
		suffix = theme.fg("dim", " stopped");
	} else {
		mark = theme.fg("error", "\u2717");
		suffix = theme.fg("error", job.error ? ` ${job.error.slice(0, 60)}` : " error");
	}
	const model = theme.fg("muted", `[${job.model}]`);
	const stats = theme.fg("dim", statsFor(job, end));
	return `${mark} ${theme.fg("dim", `#${job.id}`)} ${model} ${theme.fg("dim", "\u00b7")} ${stats}${suffix}`;
}

function runningLine(job: BtwWidgetJob, theme: WidgetTheme, frame: string, now: number): string {
	const model = theme.fg("muted", `[${job.model}]`);
	const stats = theme.fg("dim", statsFor(job, now));
	const activeMap = new Map<string, string>(job.activeTools.map((name, i) => [String(i), name]));
	const activity = theme.fg("dim", describeActivity(activeMap, job.text));
	const dot = theme.fg("dim", "\u00b7");
	return `${theme.fg("accent", frame)} ${theme.fg("toolTitle", theme.bold(`#${job.id}`))} ${model} ${dot} ${stats} ${dot} ${activity}`;
}

/**
 * Render the full widget: heading + one line per running job, then lingering
 * finished jobs, with a "+N more" overflow line when the budget is exceeded.
 * Returns [] when nothing is worth showing.
 */
export function renderBtwWidget(
	jobs: BtwWidgetJob[],
	theme: WidgetTheme,
	frame: number,
	now: number,
	width: number,
): string[] {
	const running = jobs.filter((j) => j.status === "running");
	const finished = jobs.filter((j) => j.status !== "running" && shouldShowFinished(j, now));
	if (running.length === 0 && finished.length === 0) return [];

	const truncate = (line: string) => truncateToWidth(line, width);
	const hasActive = running.length > 0;
	const headingColor = hasActive ? "accent" : "dim";
	const headingIcon = hasActive ? "\u25cb" : "\u25cf"; // ○ running · ● all done
	const spinner = SPINNER[frame % SPINNER.length] ?? "";

	const runningLines = running.map((j) =>
		truncate(`${theme.fg("dim", "\u251c\u2500")} ${runningLine(j, theme, spinner, now)}`),
	);
	const finishedLines = finished.map((j) =>
		truncate(`${theme.fg("dim", "\u251c\u2500")} ${finishedLine(j, theme)}`),
	);

	const lines: string[] = [
		truncate(
			`${theme.fg(headingColor, headingIcon)} ${theme.fg(headingColor, `BTW (${running.length})`)}`,
		),
	];

	const body = [...runningLines, ...finishedLines];
	const maxBody = MAX_WIDGET_LINES - 1;
	if (body.length <= maxBody) {
		lines.push(...body);
	} else {
		const shown = body.slice(0, maxBody - 1);
		const hidden = body.length - shown.length;
		lines.push(...shown);
		lines.push(
			truncate(`${theme.fg("dim", "\u251c\u2500")} ${theme.fg("dim", `+${hidden} more`)}`),
		);
	}

	// Fix the last connector ├─ → └─.
	const last = lines.length - 1;
	if (last > 0) lines[last] = (lines[last] ?? "").replace("\u251c\u2500", "\u2514\u2500");
	return lines;
}
