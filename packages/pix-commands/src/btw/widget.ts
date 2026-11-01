/**
 * widget.ts — pure render for the live BTW above-editor widget.
 *
 * Kept separate from index.ts (which owns job lifecycle + Pi wiring) so the
 * layout is unit-testable without a Pi host, and so registerBtw stays thin.
 * Mirrors pix-subagent's AgentWidget shape (spinner, per-job stats, finished
 * linger, overflow) for a consistent look across pix's concurrent-work UIs.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { dotJoin, rule, widgetActivityRow, widgetTitle } from "@xynogen/pix-pretty/utils";
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
export type WidgetTheme = Parameters<typeof widgetActivityRow>[0] & {
	fg(color: string, text: string): string;
	bold(text: string): string;
};

const MAX_WIDGET_LINES = 12;
const ERROR_STATUSES = new Set<BtwJobStatus>(["error", "stopped"]);

// /btw is fire-and-leave, so a finished job lingers far longer than a normal
// collapsing tool card. Both windows scale off the shared collapse delay
// (config `collapse.delaySec`, default 10s) so one knob tunes everything:
//   ok linger    = base × 3   (30s at default)
//   error linger = base × 9   (90s at default)
// The durable answer card in render.ts is the permanent record; these only
// govern the transient above-editor line.
export const OK_LINGER_SCALE = 3;
export const ERROR_LINGER_SCALE = 9;
/** Fallback base when no config delay is threaded in (pure-module/test use). */
export const DEFAULT_LINGER_BASE_MS = 10_000;

/** Resolve the ok/error linger windows from a base collapse delay. */
export function lingerWindows(baseMs: number = DEFAULT_LINGER_BASE_MS): {
	ok: number;
	error: number;
} {
	const base = baseMs > 0 ? baseMs : DEFAULT_LINGER_BASE_MS;
	return { ok: base * OK_LINGER_SCALE, error: base * ERROR_LINGER_SCALE };
}

/** True while a finished job should still linger in the widget. */
export function shouldShowFinished(job: BtwWidgetJob, now: number, baseMs?: number): boolean {
	if (job.status === "running" || job.completedAt == null) return false;
	const w = lingerWindows(baseMs);
	const linger = ERROR_STATUSES.has(job.status) ? w.error : w.ok;
	return now - job.completedAt < linger;
}

/** Any job worth painting right now (running or lingering finished). */
export function hasVisibleJobs(
	jobs: Iterable<BtwWidgetJob>,
	now: number,
	baseMs?: number,
): boolean {
	for (const job of jobs) {
		if (job.status === "running" || shouldShowFinished(job, now, baseMs)) return true;
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
	return dotJoin(parts);
}

function jobRow(
	job: BtwWidgetJob,
	theme: WidgetTheme,
	frame: string,
	now: number,
	width: number,
	first: boolean,
): string {
	const running = job.status === "running";
	const role = running
		? "accent"
		: job.status === "completed"
			? "success"
			: job.status === "error"
				? "error"
				: "muted";
	const glyph = running
		? frame
		: icon(
				job.status === "completed"
					? "status.ok"
					: job.status === "error"
						? "status.error"
						: "audio.stop",
			);
	const title = widgetTitle(theme, first ? glyph : "", first ? "BTW" : "");
	const identity = `${title}${theme.fg("toolTitle", theme.bold(`#${job.id}`))} ${theme.fg("muted", `[${job.model}]`)}${running ? "" : theme.fg(role, ` · ${job.status}`)}`;
	const stats = theme.fg("muted", statsFor(job, running ? now : (job.completedAt ?? now)));
	const activeMap = new Map(job.activeTools.map((name, i) => [String(i), name]));
	const activity =
		job.status === "error"
			? (job.error ?? "")
			: running || job.text.trim()
				? describeActivity(activeMap, job.text, width)
				: "";
	return widgetActivityRow(theme, identity, activity, width, stats);
}

/**
 * Render one content row per job, with the title only on the first row.
 * Returns [] when nothing is worth showing.
 */
export function renderBtwWidget(
	jobs: BtwWidgetJob[],
	theme: WidgetTheme,
	frame: number,
	now: number,
	width: number,
	baseMs?: number,
): string[] {
	if (width < 1) return [];
	const running = jobs.filter((j) => j.status === "running");
	const finished = jobs.filter((j) => j.status !== "running" && shouldShowFinished(j, now, baseMs));
	if (running.length === 0 && finished.length === 0) return [];

	const truncate = (line: string) => truncateToWidth(line, width);
	const spinner = SPINNER[frame % SPINNER.length] ?? "";

	const body = [...running, ...finished].map((job, i) =>
		jobRow(job, theme, spinner, now, width, i === 0),
	);
	const lines: string[] = [rule(width, (glyphs) => theme.fg("borderMuted", glyphs))];
	const maxBody = MAX_WIDGET_LINES - 1;
	if (body.length <= maxBody) {
		lines.push(...body);
	} else {
		const shown = body.slice(0, maxBody - 1);
		const hidden = body.length - shown.length;
		lines.push(...shown);
		lines.push(truncate(`  ${theme.fg("muted", `+${hidden} more`)}`));
	}

	return lines;
}
