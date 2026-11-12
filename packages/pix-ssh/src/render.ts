/** ssh_run tool card: call header and result body. */

import { resolveBaseBackground } from "@xynogen/pix-pretty/ansi";
import { collapsedCommandRow, commandPreview } from "@xynogen/pix-pretty/command-preview";
import { renderBashOutput } from "@xynogen/pix-pretty/renderers";
import type {
	RenderContextLike,
	TextComponentLike,
	ThemeLike,
	ToolResultLike,
} from "@xynogen/pix-pretty/types";
import {
	BODY_PAD,
	dotJoin,
	fillToolBackground,
	frameToolResult,
	getTextContent,
	hideCollapsedToolCall,
	outputBodyRows,
	renderCollapsed,
	renderRow,
	renderTitle,
	renderToolError,
	reuseText,
} from "@xynogen/pix-pretty/utils";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";
import type { HostAlias, HostInfo } from "./lib.ts";
import { normalizeOperation, type SshParams } from "./operation.ts";
import type { SshResultDetails } from "./result.ts";

type SshInfoDetails = { _type?: string; host?: string; info?: HostInfo; aliases?: HostAlias[] };

function safeOneLine(value: string): string {
	return value
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function terminalMeta(details: SshResultDetails): string {
	if (details.outcome === "denied") return "denied";
	if (details.outcome === "timed-out") return "timed out";
	if (details.outcome === "cancelled") return "cancelled";
	if (details.errorKind === "no-ui") return "interactive session required";
	if (details.errorKind === "auth-ssh") return "ssh auth failed";
	if (details.errorKind === "host-key") return "host key verification failed";
	if (details.errorKind === "auth-sudo") return "sudo auth failed";
	if (details.errorKind === "execution" || details.errorKind === "no-result") return "failed";

	const hasLines = typeof details.lineCount === "number" && details.lineCount > 0;
	return dotJoin([
		typeof details.exitCode === "number" && `exit ${details.exitCode}`,
		details.auth && `${details.auth} auth`,
		details.connection && `${details.connection} connection`,
		hasLines && `${details.lineCount} ${details.lineCount === 1 ? "line" : "lines"}`,
		details.truncated && "truncated",
	]);
}

function isTerminal(details: SshResultDetails): boolean {
	return details.outcome !== "awaiting-approval" && details.outcome !== "running";
}

function renderHostInfo(info: SshInfoDetails, body: string, theme: ThemeLike): string {
	const rows = [renderRow(theme, "ssh · info", info.host ?? "", "read-only")];
	if (info.info) {
		for (const [label, value] of [
			["Host", info.info.hostname],
			["User", info.info.user],
			["Port", info.info.port],
			["Via", info.info.proxyJump === "none" ? undefined : info.info.proxyJump],
			["Identity", info.info.identityFile],
		] as const) {
			if (value)
				rows.push(
					`${BODY_PAD}${theme.fg("muted", label.padEnd(9))}${theme.fg("accent", safeOneLine(value))}`,
				);
		}
	} else if (info.aliases?.length) {
		const seen = new Set<string>();
		for (const alias of info.aliases) {
			if (seen.has(alias.alias)) continue;
			seen.add(alias.alias);
			const endpoint = `${alias.user ? `${alias.user}@` : ""}${alias.hostname ?? alias.alias}${alias.port ? `:${alias.port}` : ""}`;
			rows.push(
				`${BODY_PAD}${theme.fg("accent", safeOneLine(alias.alias))}${theme.fg("muted", " · ")}${theme.fg("dim", safeOneLine(endpoint))}${alias.proxyJump && alias.proxyJump !== "none" ? theme.fg("muted", ` · via ${safeOneLine(alias.proxyJump)}`) : ""}`,
			);
		}
	} else rows.push(`${BODY_PAD}${theme.fg("muted", body)}`);
	return fillToolBackground(rows.join("\n"));
}

export function renderSshCall(args: SshParams, theme: ThemeLike, renderCtx: RenderContextLike) {
	resolveBaseBackground(theme);
	const text = reuseText(renderCtx.lastComponent);
	if (
		hideCollapsedToolCall(renderCtx.state as CollapseState, renderCtx.expanded, (value) =>
			text.setText(value),
		)
	)
		return text;

	const host = safeOneLine(args.host ?? "");
	if (args.action === "info") {
		text.setText(
			fillToolBackground(
				`${renderTitle(theme, "ssh", renderCtx, "info")} ${theme.fg("dim", host || "list aliases")}`,
			),
		);
		return text;
	}
	if (args.action === "read" || args.action === "write" || args.action === "edit") {
		text.setText(
			fillToolBackground(
				`${renderTitle(theme, "ssh", renderCtx, args.action)} ${theme.fg("dim", `${host} ${safeOneLine(args.path ?? "")}`)}`,
			),
		);
		return text;
	}
	const operation = normalizeOperation(args);
	const command = operation.command || "(empty command)";
	const prefix = operation.sudo ? "sudo " : "";
	return commandPreview(
		`${renderTitle(theme, "ssh", renderCtx, operation.action === "file" ? operation.direction : undefined)} ${theme.fg("dim", host)}`,
		operation.action === "file"
			? `${operation.source} → ${operation.destination}`
			: prefix + command,
		"bash",
		theme,
		renderCtx.state,
		renderCtx.invalidate,
		renderCtx.expanded,
		3,
		renderCtx,
	);
}

/** Result body for the `info` action, or any result without sshResult details. */
function renderInfoResult(
	result: ToolResultLike,
	theme: ThemeLike,
	renderCtx: RenderContextLike,
	text: TextComponentLike,
	isPartial: boolean,
) {
	const info = (result.details as SshInfoDetails | undefined) ?? {};
	if (
		!isPartial &&
		info._type === "sshInfo" &&
		tickCollapse("ssh", renderCtx.state as CollapseState, renderCtx.invalidate, renderCtx.expanded)
	) {
		const status = renderCtx.isError ? "error" : "success";
		text.setText(
			renderCollapsed(
				theme,
				"ssh · info",
				info.host ?? "",
				renderCtx.isError ? "failed" : "",
				status,
			),
		);
		return text;
	}
	const body = getTextContent(result) || "done";
	if (info._type === "sshInfo" && !renderCtx.isError) {
		text.setText(renderHostInfo(info, body, theme));
		return isPartial ? text : frameToolResult(text, theme, false);
	}
	text.setText(
		renderCtx.isError
			? renderToolError(body, theme)
			: fillToolBackground(
					body
						.split("\n")
						.map((line) => `${BODY_PAD}${theme.fg("muted", line)}`)
						.join("\n"),
				),
	);
	return isPartial ? text : frameToolResult(text, theme, renderCtx.isError);
}

export function renderSshResult(
	result: ToolResultLike,
	opt: unknown,
	theme: ThemeLike,
	renderCtx: RenderContextLike,
) {
	resolveBaseBackground(theme);
	const text = reuseText(renderCtx.lastComponent);
	const details = result.details as SshResultDetails | undefined;
	const isPartial = (opt as { isPartial?: boolean } | undefined)?.isPartial === true;
	const completed = (isError: boolean) => frameToolResult(text, theme, isError);

	if (details?._type !== "sshResult")
		return renderInfoResult(result, theme, renderCtx, text, isPartial);

	if (
		!isPartial &&
		isTerminal(details) &&
		tickCollapse("ssh", renderCtx.state as CollapseState, renderCtx.invalidate, renderCtx.expanded)
	) {
		const status = details.outcome === "success" ? "success" : "error";
		return collapsedCommandRow(
			renderRow(theme, "ssh", details.host, terminalMeta(details), status).trimEnd(),
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
	const lines = rendered ? rendered.split("\n") : [];

	if (!rendered) {
		text.setText(fillToolBackground(`${BODY_PAD}${summary}`));
		return isPartial ? text : completed(details.outcome !== "success");
	}

	const status = details.outcome === "success" ? "success" : "error";
	text.setText(
		fillToolBackground(outputBodyRows(lines, theme, renderCtx, status, isPartial).join("\n")),
	);
	return text;
}
