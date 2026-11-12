/** ssh_run parameters → one normalized operation, plus its approval text. */

import { getErrorMessage } from "@xynogen/pix-pretty/utils";
import { requireTool } from "@xynogen/pix-runtime/binaries";
import { prepareEditArguments, readText } from "@xynogen/pix-runtime/files";
import { initHashline } from "@xynogen/pix-runtime/hashline";
import { sftpPath } from "@xynogen/pix-runtime/sftp";
import type { TransferDirection } from "./lib.ts";

// Flat shape mirroring the single Type.Object schema. Conditional fields are
// optional here and validated at runtime by normalizeOperation.
export type SshParams = {
	action?: "command" | "upload" | "download" | "info" | "read" | "write" | "edit";
	host?: string;
	command?: string;
	path?: string;
	content?: string;
	offset?: number;
	limit?: number;
	edits?: unknown;
	sudo?: boolean;
	source?: string;
	destination?: string;
	recursive?: boolean;
	reason?: string;
	fresh?: boolean;
};

export interface SshOperation {
	action: "command" | "file" | "read" | "write" | "edit";
	command: string;
	sudo: boolean;
	reason?: string;
	direction?: TransferDirection;
	source: string;
	destination: string;
	recursive: boolean;
}

export function isFileAction(action: SshParams["action"]): action is "read" | "write" | "edit" {
	return action === "read" || action === "write" || action === "edit";
}

export async function validateFile(params: SshParams) {
	if (!isFileAction(params.action)) return;
	if (params.sudo) throw new Error("SFTP file actions do not support sudo");
	params.path = sftpPath(params.path ?? "");
	if (params.action === "write" && typeof params.content !== "string")
		throw new Error("content is required for write");
	if (params.action === "edit")
		params.edits = (
			prepareEditArguments({ path: params.path, edits: params.edits }) as { edits: unknown }
		).edits;
	await initHashline();
	if (params.action === "read") readText(Buffer.alloc(0), params.offset, params.limit);
}

export function normalizeOperation(params: SshParams): SshOperation {
	if (params.action === "read" || params.action === "write" || params.action === "edit") {
		return {
			action: params.action,
			command: `${params.action} ${params.path ?? "(empty path)"}`,
			sudo: false,
			reason: params.reason,
			source: params.path ?? "",
			destination: "",
			recursive: false,
		};
	}
	if (params.action === "upload" || params.action === "download") {
		const source = (params.source ?? "").trim();
		const destination = (params.destination ?? "").trim();
		return {
			action: "file",
			command: `${params.action} ${source || "(empty source)"} → ${destination || "(empty destination)"}`,
			sudo: false,
			reason: params.reason,
			direction: params.action,
			source,
			destination,
			recursive: params.recursive === true,
		};
	}
	return {
		action: "command",
		command: params.command ?? "",
		sudo: params.sudo === true,
		reason: params.reason,
		source: "",
		destination: "",
		recursive: false,
	};
}

/**
 * The pix-runtime lookup message for the first missing binary this action
 * needs (ssh, plus scp for file transfers), or undefined when all resolve.
 * sshpass is checked lazily: it only matters when a login password is used.
 */
export function missingSshTools(action: SshOperation["action"]): string | undefined {
	for (const name of action === "file"
		? ["ssh", "scp"]
		: action === "command"
			? ["ssh"]
			: ["ssh", "sftp"]) {
		try {
			requireTool(name);
		} catch (err) {
			return getErrorMessage(err);
		}
	}
	return undefined;
}

/** The model's reason heads the modal; the action name is only the fallback. */
export function approvalTitle({ action, direction, reason }: SshOperation): string {
	if (reason?.trim()) return reason.trim();
	if (action === "read" || action === "write" || action === "edit") return `SSH ${action}`;
	if (action !== "file") return "SSH Command Request";
	return `SSH ${direction === "download" ? "Download" : "Upload"}`;
}

export function approvalBody(operation: SshOperation, host: string, port?: number): string[] {
	const { action, destination, direction, reason, recursive, source } = operation;
	return [
		...(reason?.trim() ? [] : ["No reason provided by AI"]),
		`Host: ${host}${port ? ` (port ${port})` : ""}`,
		...(action !== "file"
			? [
					action === "command"
						? "Review the command in the tool card below."
						: `${action.toUpperCase()} ${source}`,
					...(action === "write" ? ["Warning: replaces the entire file"] : []),
				]
			: [
					`Direction: ${direction === "download" ? "Download" : "Upload"}`,
					`From: ${source}`,
					`To: ${destination}`,
					`Mode: ${recursive ? "Recursive copy" : "Single item"}`,
					"Warning: existing destination may be overwritten",
				]),
	];
}
