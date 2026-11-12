/** sudo_run tool card: call header and result body. */

import { resolveBaseBackground } from "@xynogen/pix-pretty/ansi";
import { collapsedCommandRow, commandPreview } from "@xynogen/pix-pretty/command-preview";
import { renderBashOutput } from "@xynogen/pix-pretty/renderers";
import type { RenderContextLike, ThemeLike, ToolResultLike } from "@xynogen/pix-pretty/types";
import {
	BODY_PAD,
	dotJoin,
	fillToolBackground,
	frameToolResult,
	getTextContent,
	hideCollapsedToolCall,
	outputBodyRows,
	renderRow,
	renderTitle,
	renderToolError,
	reuseText,
} from "@xynogen/pix-pretty/utils";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";
import type { SudoResultDetails } from "./result.ts";

function safeOneLine(value: string): string {
	return value
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function terminalMeta(details: SudoResultDetails): string {
	if (details.outcome === "denied") return "denied";
	if (details.outcome === "timed-out") return "timed out";
	if (details.outcome === "cancelled") return "cancelled";
	if (details.errorKind === "no-ui") return "interactive session required";
	if (details.errorKind === "authentication") return "authentication failed";
	if (details.errorKind === "execution" || details.errorKind === "no-result") return "failed";

	const hasLines = typeof details.lineCount === "number" && details.lineCount > 0;
	return dotJoin([
		typeof details.exitCode === "number" && `exit ${details.exitCode}`,
		hasLines && `${details.lineCount} ${details.lineCount === 1 ? "line" : "lines"}`,
		details.truncated && "truncated",
	]);
}

function isTerminal(details: SudoResultDetails): boolean {
	return details.outcome !== "awaiting-approval" && details.outcome !== "running";
}

export function renderSudoCall(
	args: { command: string; reason?: string },
	theme: ThemeLike,
	renderCtx: RenderContextLike,
) {
	resolveBaseBackground(theme);
	const text = reuseText(renderCtx.lastComponent);
	if (
		hideCollapsedToolCall(renderCtx.state as CollapseState, renderCtx.expanded, (value) =>
			text.setText(value),
		)
	)
		return text;

	return commandPreview(
		renderTitle(theme, "sudo", renderCtx),
		args.command || "(empty command)",
		"bash",
		theme,
		renderCtx.state,
		renderCtx.invalidate,
		renderCtx.expanded,
		3,
		renderCtx,
	);
}

export function renderSudoResult(
	result: ToolResultLike,
	opt: unknown,
	theme: ThemeLike,
	renderCtx: RenderContextLike,
) {
	resolveBaseBackground(theme);
	const text = reuseText(renderCtx.lastComponent);
	const details = result.details as SudoResultDetails | undefined;
	const isPartial = (opt as { isPartial?: boolean } | undefined)?.isPartial === true;
	const completed = (isError: boolean) => frameToolResult(text, theme, isError);

	if (details?._type !== "sudoResult") {
		if (renderCtx.isError) {
			text.setText(renderToolError(getTextContent(result) || "Error", theme));
		} else {
			text.setText(
				fillToolBackground(`${BODY_PAD}${theme.fg("muted", getTextContent(result) || "done")}`),
			);
		}
		return isPartial ? text : completed(renderCtx.isError);
	}

	if (
		!isPartial &&
		isTerminal(details) &&
		tickCollapse("sudo", renderCtx.state as CollapseState, renderCtx.invalidate, renderCtx.expanded)
	) {
		const status = details.outcome === "success" ? "success" : "error";
		return collapsedCommandRow(
			renderRow(theme, "sudo", "", terminalMeta(details), status).trimEnd(),
			safeOneLine(details.command),
			theme,
		);
	}

	if (details.outcome === "awaiting-approval" || details.outcome === "running") {
		text.setText(
			fillToolBackground(`${BODY_PAD}${theme.fg("muted", getTextContent(result) || "working")}`),
		);
		return text;
	}

	if (details.outcome !== "success" && details.errorKind !== "exit-code") {
		const diagnostic = getTextContent(result) || "Error";
		text.setText(
			details.outcome === "error"
				? renderToolError(diagnostic, theme)
				: fillToolBackground(`${BODY_PAD}${theme.fg("warning", diagnostic)}`),
		);
		return isPartial ? text : completed(true);
	}

	const code = typeof details.exitCode === "number" ? details.exitCode : null;
	const rendered = typeof details._render === "string" ? details._render : "";
	const { summary } = renderBashOutput(rendered, code, theme);

	if (!rendered) {
		text.setText(fillToolBackground(`${BODY_PAD}${summary}`));
		return isPartial ? text : completed(details.outcome !== "success");
	}

	// Every result (including single-line) is framed; the rules follow exit
	// status: green ok, red failure. The `✓ exit N` header is dropped — the
	// collapsed row already carries status.
	const status = details.outcome === "success" ? "success" : "error";
	const rows = outputBodyRows(rendered.split("\n"), theme, renderCtx, status, isPartial);
	text.setText(fillToolBackground(rows.join("\n")));
	return text;
}
