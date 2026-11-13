/** proc tool card: call header and result body. */

import { commandPreview } from "@xynogen/pix-pretty/command-preview";
import { stripTerminalSequences, Text, type Theme } from "@xynogen/pix-pretty/tui";
import type { RenderContextLike, ToolResultLike } from "@xynogen/pix-pretty/types";
import {
	BODY_PAD,
	expandHint,
	frameToolResult,
	hideCollapsedToolCall,
	pluralize,
	renderDimPreview,
	renderRow,
	renderTitle,
} from "@xynogen/pix-pretty/utils";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";
import type { ProcResultDetails } from "./actions.ts";
import { processRow } from "./widget.ts";

// proc never reuses lastComponent; Pi's Component lacks setText, so drop it from the context type.
type ProcRenderContext = Omit<RenderContextLike, "lastComponent">;

const clean = (value: string) =>
	stripTerminalSequences(value)
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.trim();

export function renderProcCall(
	args: { action?: string; command?: string; handle?: string },
	theme: Theme,
	context: ProcRenderContext,
) {
	if (hideCollapsedToolCall(context.state as CollapseState, context.expanded, () => {}))
		return new Text("", 0, 0);
	const target = args.command ?? args.handle ?? "";
	if (!args.command)
		return new Text(
			`${renderTitle(theme, "proc", context, args.action)}${target ? `${theme.fg("muted", " · ")}${theme.fg("dim", target)}` : ""}`,
			0,
			0,
		);
	return commandPreview(
		renderTitle(theme, "proc", context, args.action),
		target,
		"bash",
		theme,
		context.state,
		context.invalidate,
		context.expanded,
		3,
		context,
	);
}

/** Body rows below the heading: processes, notes, error, log path, output preview. */
function bodyRows(
	details: ProcResultDetails | undefined,
	fallback: string,
	expanded: boolean,
	width: number,
	theme: Theme,
	context: ProcRenderContext,
): string[] {
	const rows: string[] = [];
	const now = Date.now();
	const processes = details?.processes ?? [];
	const shown = expanded ? processes : processes.slice(0, 6);
	for (const proc of shown) {
		rows.push(`${BODY_PAD}${processRow(proc, now, Math.max(1, width - 3), theme)}`);
		rows.push(
			`${BODY_PAD}${theme.fg("muted", `${clean(proc.handle)} · pid ${proc.pid} · ${clean(proc.cwd)}${proc.foreign ? " · read-only" : ""}`)}`,
		);
		if (proc.logError) rows.push(`${BODY_PAD}${theme.fg("error", clean(proc.logError))}`);
	}
	const notes = details?.notes ?? [];
	const noteRole = details?.action === "stop" || details?.action === "rm" ? "muted" : "warning";
	for (const note of notes) rows.push(`${BODY_PAD}${theme.fg(noteRole, clean(note))}`);
	if (details?.error) rows.push(`${BODY_PAD}${theme.fg("error", details.error)}`);
	if (details?.logPath)
		rows.push(`${BODY_PAD}${theme.fg("muted", `Full log · ${clean(details.logPath)}`)}`);
	const output =
		details?.output ??
		(processes.length || notes.length || details?.error
			? []
			: (details?.lines ?? fallback.split("\n")));
	if (output.length)
		rows.push(
			renderDimPreview(output.join("\n"), theme, {
				maxLines: expanded ? output.length : 8,
				ctx: context,
			}),
		);
	if (processes.length > shown.length)
		rows.push(
			`${BODY_PAD}${theme.fg("muted", `… ${processes.length - shown.length} more processes `)}${expandHint(theme, context)}`,
		);
	return rows;
}

export function renderProcResult(
	result: ToolResultLike,
	options: { isPartial: boolean; expanded: boolean },
	theme: Theme,
	context: ProcRenderContext,
) {
	const details = result.details as ProcResultDetails | undefined;
	const fallback = result.content
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("\n");
	const failed = context.isError || details?.ok === false;
	const title = details?.action ? `proc · ${details.action}` : "proc";
	const target = clean(
		details?.error ??
			details?.handle ??
			(details?.action === "list"
				? pluralize(details.processes?.length ?? details.lines.length, "process", "processes")
				: (details?.lines[0] ?? "")),
	);
	const meta = details?.output?.length ? pluralize(details.output.length, "line") : "";
	const collapsed =
		!options.isPartial &&
		tickCollapse("proc", context.state as CollapseState, context.invalidate, options.expanded);
	// The call row shows title and target; the heading only replaces it once collapsed hides it.
	const component = {
		render(width: number): string[] {
			if (collapsed)
				return [renderRow(theme, title, target, meta, failed ? "error" : "success", width)];
			const rows = bodyRows(details, fallback, options.expanded, width, theme, context);
			return new Text(rows.join("\n"), 0, 0).render(width);
		},
		invalidate() {},
	};
	return options.isPartial || collapsed ? component : frameToolResult(component, theme, failed);
}
