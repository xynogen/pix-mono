/** sudo_run tool card: call header and result body. */

import { resolveBaseBackground } from "@xynogen/pix-pretty/ansi";
import { commandPreview } from "@xynogen/pix-pretty/command-preview";
import { gatedCommandMeta, renderGatedCommandResult } from "@xynogen/pix-pretty/shell-tool";
import type { RenderContextLike, ThemeLike, ToolResultLike } from "@xynogen/pix-pretty/types";
import {
	BODY_PAD,
	fillToolBackground,
	frameToolResult,
	getTextContent,
	hideCollapsedToolCall,
	renderTitle,
	renderToolError,
	reuseText,
} from "@xynogen/pix-pretty/utils";
import type { CollapseState } from "@xynogen/pix-runtime/collapse";
import type { SudoResultDetails } from "./result.ts";

const SUDO_ERRORS: Record<string, string> = {
	"no-ui": "interactive session required",
	authentication: "authentication failed",
	execution: "failed",
	"no-result": "failed",
};

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
	const details = result.details as SudoResultDetails | undefined;
	const isPartial = (opt as { isPartial?: boolean } | undefined)?.isPartial === true;

	if (details?._type !== "sudoResult") {
		const text = reuseText(renderCtx.lastComponent);
		if (renderCtx.isError) {
			text.setText(renderToolError(getTextContent(result) || "Error", theme));
		} else {
			text.setText(
				fillToolBackground(`${BODY_PAD}${theme.fg("muted", getTextContent(result) || "done")}`),
			);
		}
		return isPartial ? text : frameToolResult(text, theme, renderCtx.isError);
	}

	return renderGatedCommandResult(
		result,
		details,
		{ name: "sudo", target: "", meta: gatedCommandMeta(details, SUDO_ERRORS) },
		isPartial,
		theme,
		renderCtx,
	);
}
