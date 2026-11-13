/** ssh_run tool card: call header and result body. */

import { resolveBaseBackground } from "@xynogen/pix-pretty/ansi";
import { commandPreview } from "@xynogen/pix-pretty/command-preview";
import {
	gatedCommandMeta,
	renderGatedCommandResult,
	safeOneLine,
} from "@xynogen/pix-pretty/shell-tool";
import type {
	RenderContextLike,
	TextComponentLike,
	ThemeLike,
	ToolResultLike,
} from "@xynogen/pix-pretty/types";
import {
	BODY_PAD,
	fillToolBackground,
	frameToolResult,
	getTextContent,
	hideCollapsedToolCall,
	renderCollapsed,
	renderTitle,
	renderToolError,
	reuseText,
} from "@xynogen/pix-pretty/utils";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";
import type { HostAlias, HostInfo } from "./lib.ts";
import { normalizeOperation, type SshParams } from "./operation.ts";
import type { SshResultDetails } from "./result.ts";

type SshInfoDetails = { _type?: string; host?: string; info?: HostInfo; aliases?: HostAlias[] };

const SSH_ERRORS: Record<string, string> = {
	"no-ui": "interactive session required",
	"auth-ssh": "ssh auth failed",
	"host-key": "host key verification failed",
	"auth-sudo": "sudo auth failed",
	execution: "failed",
	"no-result": "failed",
};

function renderHostInfo(info: SshInfoDetails, body: string, theme: ThemeLike): string {
	// The call row carries `ssh · info <host>`; the body lists only the details.
	const rows: string[] = [];
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
	const details = result.details as SshResultDetails | undefined;
	const isPartial = (opt as { isPartial?: boolean } | undefined)?.isPartial === true;
	if (details?._type !== "sshResult") {
		const text = reuseText(renderCtx.lastComponent);
		return renderInfoResult(result, theme, renderCtx, text, isPartial);
	}
	const meta = gatedCommandMeta(details, SSH_ERRORS, [
		details.auth && `${details.auth} auth`,
		details.connection && `${details.connection} connection`,
	]);
	return renderGatedCommandResult(
		result,
		details,
		{ name: "ssh", target: details.host, meta },
		isPartial,
		theme,
		renderCtx,
	);
}
