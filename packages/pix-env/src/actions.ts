/** actions.ts — `read_env` actions: gated reveal (info/read) and gated write (add/edit). */

import { showOverlay } from "@xynogen/pix-pretty/gate-overlay";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { getErrorMessage } from "@xynogen/pix-pretty/utils";
import { getUnattendedMode } from "@xynogen/pix-runtime";
import { writeFileAtomicSync } from "@xynogen/pix-runtime/atomic-write";
import { existsSync, readFileSync, statSync } from "@xynogen/pix-runtime/fs";
import type { ExtensionAPI, ExtensionContext } from "@xynogen/pix-runtime/host";
import { validateOutputPath } from "@xynogen/pix-runtime/safe-path";
import { describeRegistry, editEnvText, envPath, loadPath, loadRegistry } from "./lib.ts";
import type { ReadEnvDetails } from "./render.ts";

export interface ReadEnvParams {
	action: "info" | "read" | "add" | "edit";
	path?: string;
	names?: string[];
	name?: string;
	value?: string | number | boolean;
}

export interface ReadEnvResult {
	content: Array<{ type: "text"; text: string }>;
	details: ReadEnvDetails;
	isError?: boolean;
}

function fail(text: string, details: ReadEnvDetails): ReadEnvResult {
	return { content: [{ type: "text", text }], details, isError: true };
}

function ok(text: string, details: ReadEnvDetails): ReadEnvResult {
	return { content: [{ type: "text", text }], details };
}

/** Approve in nuclear mode, else ask. Null when no UI can ask. */
async function approve(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	overlay: Omit<Parameters<typeof showOverlay>[1], "state" | "signal" | "mode" | "icon"> & {
		message: string;
	},
): Promise<string | null> {
	if (getUnattendedMode(pi.events) === "nuclear") return "approved";
	if (!ctx.hasUI) return null;
	const { message, ...rest } = overlay;
	const result = await showOverlay(ctx.ui, {
		state: { events: pi.events, source: "read_env", message },
		signal,
		mode: "confirm",
		icon: icon("secret"),
		...rest,
	});
	return result.action;
}

/** add/edit: one key in one file, after approval, with a stale-file check before the write. */
export async function writeEnv(
	pi: ExtensionAPI,
	params: ReadEnvParams,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
	onWritten: () => void,
): Promise<ReadEnvResult> {
	const action = params.action as "add" | "edit";
	try {
		if (!params.name || params.value === undefined)
			throw new Error("name and value are required for add/edit");
		if (params.path === undefined) throw new Error("path is required for add/edit");
		const path = envPath(params.path, ctx.cwd);
		const safe = await validateOutputPath(path);
		if (!safe.ok) throw new Error(safe.reason);
		if (existsSync(path) && !statSync(path).isFile())
			throw new Error("env path must be a regular file");
		const before = existsSync(path) ? readFileSync(path, "utf-8") : null;
		const next = editEnvText(before ?? "", params.name, String(params.value), action);
		const outcome = await approve(pi, ctx, signal, {
			message: "env write approval",
			title: `${action === "add" ? "Add" : "Edit"} Environment Variable`,
			body: [
				`File: ${path}`,
				`Variable: ${params.name}`,
				"Values are hidden. Other assignments are preserved.",
			],
			accent: "warning",
			timeoutMs: 30_000,
			choices: [
				{ value: "no", label: "Deny", description: "Keep file unchanged" },
				{ value: "yes", label: "Write", description: `Save ${params.name}` },
			],
			approveValue: "yes",
		});
		if (outcome === null) throw new Error("env writes require interactive user approval");
		signal?.throwIfAborted();
		if (outcome !== "approved")
			return ok(`read_env ${outcome}: ${params.name}`, { action, name: params.name, outcome });
		const recheck = await validateOutputPath(path);
		if (!recheck.ok) throw new Error(recheck.reason);
		if ((existsSync(path) ? readFileSync(path, "utf-8") : null) !== before)
			throw new Error("env file changed during approval; retry with the current file");
		// ponytail: single-writer atomic save; add cross-process locking for concurrent writers.
		signal?.throwIfAborted();
		writeFileAtomicSync(path, next);
		onWritten();
		return ok(
			`${action === "add" ? "Added" : "Edited"} ${params.name} in ${path} (value hidden).`,
			{ action, name: params.name, path },
		);
	} catch (error) {
		return fail(`read_env failed: ${getErrorMessage(error)}`, { action });
	}
}

/** info: names and types only. read: reveal exactly the named values, after approval. */
export async function readEnv(
	pi: ExtensionAPI,
	params: ReadEnvParams,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
): Promise<ReadEnvResult> {
	let reg: Map<string, string>;
	try {
		reg = params.path !== undefined ? loadPath(params.path, ctx.cwd) : loadRegistry(ctx.cwd);
	} catch (error) {
		return fail(`read_env failed: ${getErrorMessage(error)}`, { action: params.action });
	}
	if (params.action === "info") {
		const types = describeRegistry(reg);
		const text = Object.entries(types)
			.map(([key, type]) => `${key} = ${type}`)
			.join("\n");
		return ok(text || "No env variables loaded.", {
			action: "info",
			count: Object.keys(types).length,
			types,
		});
	}

	const denied = { action: "read", revealed: [] };
	const names = [...new Set(params.names?.map((name) => name.trim()).filter(Boolean) ?? [])];
	if (names.length === 0)
		return fail('read_env failed: names is required for action="read"', denied);
	const unknown = names.filter((name) => !reg.has(name));
	if (unknown.length > 0)
		return fail(`read_env failed: unknown env variable(s): ${unknown.join(", ")}`, denied);

	const list = names.sort((a, b) => a.localeCompare(b)).join(", ");
	const outcome = await approve(pi, ctx, signal, {
		message: "secret disclosure approval",
		title: `Reveal Environment Value${names.length > 1 ? "s" : ""}`,
		body: [
			`Variables: ${list}`,
			"Warning: approved values enter model context and session transcript.",
		],
		accent: "error",
		timeoutMs: 30_000,
		choices: [
			{ value: "no", label: "Deny", description: "Keep values hidden" },
			{ value: "yes", label: "Reveal", description: `Expose only ${list}` },
		],
		approveValue: "yes",
	});
	if (outcome === null) return fail("read_env requires interactive user approval.", denied);
	signal?.throwIfAborted();
	if (outcome !== "approved") return ok(`read_env ${outcome}: ${list}`, { ...denied, outcome });
	return ok(names.map((name) => `${name}=${reg.get(name) as string}`).join("\n"), {
		action: "read",
		revealed: names,
	});
}
