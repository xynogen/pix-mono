/** sudo_run result details and the result objects built from them. */

import type { OverlayResult } from "@xynogen/pix-pretty/gate-overlay";
import { gatedCancellation } from "@xynogen/pix-pretty/shell-tool";
import { normalizeLineEndings } from "@xynogen/pix-pretty/utils";
import type { AgentToolUpdateCallback } from "@xynogen/pix-runtime/host";

export type SudoOutcome =
	| "awaiting-approval"
	| "running"
	| "success"
	| "denied"
	| "timed-out"
	| "cancelled"
	| "error";

export type SudoCancellationKind = "denied" | "timeout" | "missing-password" | "aborted";
export type SudoErrorKind = "no-ui" | "authentication" | "execution" | "no-result" | "exit-code";

export interface SudoResultDetails {
	_type: "sudoResult";
	command: string;
	reason?: string;
	outcome: SudoOutcome;
	exitCode?: number;
	lineCount?: number;
	truncated?: boolean;
	cancellationKind?: SudoCancellationKind;
	errorKind?: SudoErrorKind;
	_render?: string;
}

export type SudoDetailFields = Omit<SudoResultDetails, "_type" | "command" | "reason">;

export function makeDetails(
	command: string,
	reason: string | undefined,
	fields: SudoDetailFields,
): SudoResultDetails {
	return {
		_type: "sudoResult",
		command,
		...(reason?.trim() ? { reason: reason.trim() } : {}),
		...fields,
	};
}

export function outputLineCount(output: string): number {
	const normalized = normalizeLineEndings(output).replace(/^\n+|\n+$/g, "");
	return normalized ? normalized.split("\n").length : 0;
}

export function updatePresentation(
	onUpdate: AgentToolUpdateCallback<SudoResultDetails> | undefined,
	command: string,
	reason: string | undefined,
	outcome: "awaiting-approval" | "running",
): void {
	onUpdate?.({
		content: [
			{
				type: "text",
				text: outcome === "awaiting-approval" ? "Awaiting root approval…" : "Running as root…",
			},
		],
		details: makeDetails(command, reason, { outcome }),
	});
}

export function cancelResult(
	command: string,
	reason: string | undefined,
	action: OverlayResult["action"],
): { content: { type: "text"; text: string }[]; details: SudoResultDetails } {
	const { outcome, cancellationKind, text } = gatedCancellation(action);
	return {
		content: [{ type: "text", text }],
		details: makeDetails(command, reason, { outcome, cancellationKind }),
	};
}
