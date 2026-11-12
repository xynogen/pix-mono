/** ssh_run result details and the result objects built from them. */

import type { OverlayResult } from "@xynogen/pix-pretty/gate-overlay";
import { normalizeLineEndings } from "@xynogen/pix-pretty/utils";
import type { AgentToolUpdateCallback } from "@xynogen/pix-runtime/host";

export type SshOutcome =
	| "awaiting-approval"
	| "running"
	| "success"
	| "denied"
	| "timed-out"
	| "cancelled"
	| "error";

export type SshCancellationKind = "denied" | "timeout" | "missing-password" | "aborted";
export type SshErrorKind =
	| "no-ui"
	| "auth-ssh"
	| "auth-sudo"
	| "host-key"
	| "execution"
	| "no-result"
	| "exit-code";

export interface SshResultDetails {
	_type: "sshResult";
	command: string;
	host: string;
	sudo?: boolean;
	reason?: string;
	outcome: SshOutcome;
	exitCode?: number;
	lineCount?: number;
	truncated?: boolean;
	cancellationKind?: SshCancellationKind;
	errorKind?: SshErrorKind;
	/** How this call authenticated: SSH key/agent, or a login password. */
	auth?: "key" | "password";
	/** Whether this call opened a new connection or reused a live master. */
	connection?: "new" | "reused";
	_render?: string;
}

export type SshDetailFields = Omit<
	SshResultDetails,
	"_type" | "command" | "host" | "sudo" | "reason"
>;

export function makeDetails(
	command: string,
	host: string,
	sudo: boolean,
	reason: string | undefined,
	fields: SshDetailFields,
): SshResultDetails {
	return {
		_type: "sshResult",
		command,
		host,
		sudo,
		...(reason?.trim() ? { reason: reason.trim() } : {}),
		...fields,
	};
}

export function outputLineCount(output: string): number {
	const normalized = normalizeLineEndings(output).replace(/^\n+|\n+$/g, "");
	return normalized ? normalized.split("\n").length : 0;
}

export function updatePresentation(
	onUpdate: AgentToolUpdateCallback<SshResultDetails> | undefined,
	command: string,
	host: string,
	sudo: boolean,
	reason: string | undefined,
	outcome: "awaiting-approval" | "running",
	message?: string,
): void {
	onUpdate?.({
		content: [
			{
				type: "text",
				text:
					message ??
					(outcome === "awaiting-approval" ? "Awaiting approval…" : `Running on ${host}…`),
			},
		],
		details: makeDetails(command, host, sudo, reason, { outcome }),
	});
}

export function cancelResult(
	command: string,
	host: string,
	sudo: boolean,
	reason: string | undefined,
	action: OverlayResult["action"],
): { content: { type: "text"; text: string }[]; details: SshResultDetails } {
	const cancellationKind: SshCancellationKind =
		action === "timeout" ? "timeout" : action === "denied" ? "denied" : "missing-password";
	const outcome: SshOutcome =
		cancellationKind === "timeout"
			? "timed-out"
			: cancellationKind === "denied"
				? "denied"
				: "cancelled";
	const msg =
		outcome === "timed-out"
			? "Timed out — auto-denied."
			: outcome === "denied"
				? "Denied by user."
				: "Cancelled — no password entered.";
	return {
		content: [{ type: "text", text: `Cancelled — ${msg}` }],
		details: makeDetails(command, host, sudo, reason, { outcome, cancellationKind }),
	};
}
