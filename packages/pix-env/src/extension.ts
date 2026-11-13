/**
 * pix-env — Pi extension
 *
 * Loads `.env` files into an in-memory registry the AI never sees the values
 * of. The AI authors `$KEY` / `${KEY}` references; on every `tool_call` those
 * references are resolved into the real value AFTER a yolo-style approval
 * popup, mutating the tool input in place.
 *
 * The bash tool receives shell-quoted values; all other tools receive raw
 * values. Key *names* (never values) are advertised to the model once via the
 * system prompt so it knows what it may reference.
 *
 * ACCEPTED LIMITATION: resolved values may appear in a tool's rendered call or
 * output if that tool echoes them back. This module guarantees the reference
 * stays a placeholder until the gated injection — it does not scrub output.
 */

import { StringEnum } from "@xynogen/pix-data/ai";
import { showOverlay } from "@xynogen/pix-pretty/gate-overlay";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { renderCall } from "@xynogen/pix-pretty/utils";
import { getUnattendedMode } from "@xynogen/pix-runtime";
import type { ExtensionAPI } from "@xynogen/pix-runtime/host";
import { once } from "@xynogen/pix-runtime/once";
import { Type } from "typebox";
import { readEnv, writeEnv } from "./actions.ts";
import {
	allRefsIn,
	collectRefs,
	collectUnsupported,
	loadRegistry,
	resolveInput,
	shellPrelude,
} from "./lib.ts";
import { renderReadEnvResult } from "./render.ts";

const REF_TAG = "pix-env-secrets";

export default function pixEnvExtension(pi: ExtensionAPI): void {
	once(pi, "pix-env", () => {
		// Load the registry per-event against the current cwd (cached per dir), not
		// once at start. A session that begins outside the project — or a `.env`
		// created mid-session — then still gets brokered without a restart.
		const cache = new Map<string, Map<string, string>>();
		const getReg = (): Map<string, string> => {
			const cwd = process.cwd();
			let reg = cache.get(cwd);
			if (!reg) {
				reg = loadRegistry(cwd);
				cache.set(cwd, reg);
			}
			return reg;
		};

		pi.registerTool({
			name: "read_env",
			...({ exposure: "deferred" } as const),
			label: "Environment",
			description:
				'Inspect, read, add, or edit environment (env) variables: check which are set. "info" returns names/types only. "read" reveals only requested names. "add" creates a new key; "edit" changes an existing key using name/value. Read disclosure and writes require user approval. Never request unrelated variables.',
			promptSnippet: "Inspect, read, add, or edit env variables with gated disclosure and writes",
			parameters: Type.Object(
				{
					action: StringEnum(["info", "read", "add", "edit"] as const, {
						description:
							'"info" lists names/types; "read" reveals names; "add" creates and "edit" updates name/value.',
					}),
					path: Type.Optional(
						Type.String({
							description:
								"File named .env or .env.<suffix>, including .env.examples; relative to cwd. Read/info also accept a directory. Required for add/edit. Default for read/info: configured files.",
							minLength: 1,
						}),
					),
					names: Type.Optional(
						Type.Array(Type.String(), {
							description: 'Exact variable names to reveal. Required for action="read".',
							minItems: 1,
						}),
					),
					name: Type.Optional(
						Type.String({
							description: "Exact variable name, required for add/edit (for example APP_PORT).",
							pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
							minLength: 1,
						}),
					),
					value: Type.Optional(
						Type.Union([Type.String(), Type.Number(), Type.Boolean()], {
							description:
								"Single-line value required for add/edit, for example 8080. Stored as text. Supplied values enter the transcript; use $KEY for existing brokered secrets.",
						}),
					),
				},
				{
					// Keep an object root for provider compatibility, with action-specific requirements.
					anyOf: [
						{ properties: { action: { const: "info" } } },
						{ properties: { action: { const: "read" } }, required: ["names"] },
						{
							properties: { action: { enum: ["add", "edit"] } },
							required: ["path", "name", "value"],
						},
					],
				},
			),
			renderShell: "self",
			renderCall: renderCall(
				"read_env",
				(args) =>
					String(
						args.name ?? (Array.isArray(args.names) ? args.names.join(", ") : (args.path ?? "")),
					),
				(args) => String(args.action ?? ""),
			),
			renderResult: renderReadEnvResult,
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				signal?.throwIfAborted();
				const { action } = params;
				if (action === "add" || action === "edit")
					return writeEnv(pi, { ...params, action }, signal, ctx, () => cache.clear());
				return readEnv(pi, { ...params, action: action === "info" ? "info" : "read" }, signal, ctx);
			},
		});

		// ── Advertise key NAMES only (values stay in the registry) ──────────
		pi.on("before_agent_start", (event) => {
			const reg = getReg();
			if (reg.size === 0) return; // nothing to advertise from this cwd
			const existing = event.systemPrompt ?? "";
			if (existing.includes(`<${REF_TAG}>`)) return; // idempotent on retry
			const names = [...reg.keys()].sort((a, b) => a.localeCompare(b)).join(", ");
			const body =
				`Secret env vars available (VALUES HIDDEN). Reference them as $KEY or ` +
				`\${KEY} in any tool argument — the value is injected at run time after ` +
				`user approval, never shown to you. In bash you may use any form including ` +
				`parameter-expansion modifiers (\${KEY%/}, \${KEY:-x}, \${KEY#p}); the value is ` +
				`exported into the shell first. In non-bash tools use plain $KEY / \${KEY} only: ${names}`;
			const block = `<${REF_TAG}>\n${body}\n</${REF_TAG}>`;
			return { systemPrompt: existing ? `${existing}\n\n${block}` : block };
		});

		// ── Resolve references on every tool call, gated by approval ────────
		pi.on("tool_call", async (event, ctx) => {
			const reg = getReg();
			if (reg.size === 0) return undefined; // no secrets loaded from this cwd
			const shell = event.toolName === "bash";

			// Non-bash tools have no shell to expand parameter-expansion modifiers, so a
			// ${KEY%/} there would reach the tool as a literal. Block + nudge. In bash
			// these are handled natively via the export prelude below, so allow them.
			if (!shell) {
				const bad = collectUnsupported(event.input, reg);
				if (bad.length > 0) {
					const blist = bad.sort((a, b) => a.localeCompare(b)).join(", ");
					return {
						block: true,
						reason:
							`[pix-env] parameter-expansion modifiers (\${KEY%/}, \${KEY:-x}, \${KEY#p}) ` +
							`are only supported in bash. For "${event.toolName}" use plain $KEY or \${KEY}: ${blist}.`,
					};
				}
			}

			// bash considers every ref form (modifiers included); others only plain refs.
			const keys = shell
				? allRefsIn(JSON.stringify(event.input), reg)
				: collectRefs(event.input, reg);
			if (keys.length === 0) return undefined;

			const mode = getUnattendedMode(pi.events);
			const list = keys.sort((a, b) => a.localeCompare(b)).join(", ");

			// AFK: auto-deny so no secret is injected while away.
			if (mode === "afk") {
				return { block: true, reason: `[pix-env] secret injection auto-denied (AFK): ${list}` };
			}

			// YOLO: auto-inject without the popup.
			if (mode === "yolo" || mode === "nuclear") {
				ctx.ui?.notify?.(`Secret auto-injected — ${mode.toUpperCase()}: ${list}`, "warning");
				inject(event, reg, shell, keys);
				return undefined;
			}

			// No UI (unattended): refuse injection rather than leak silently.
			if (!ctx.hasUI) {
				return {
					block: true,
					reason: `[pix-env] secret injection needs UI approval: ${keys.join(", ")}`,
				};
			}

			const result = await showOverlay(ctx.ui, {
				state: { events: pi.events, source: "pix-env", message: "secret approval" },
				mode: "confirm",
				icon: icon("secret"),
				title: `Inject Secret${keys.length > 1 ? "s" : ""} — ${list}`,
				body: [
					`Tool "${event.toolName}" will receive the real value of: ${list}`,
					...`Command: ${secretTarget(event.input)}`.split("\n"),
					"Value is not shown here and stays out of your transcript unless the tool echoes it.",
					`${icon("status.warn")} Warning: a tool that prints or logs its input (echo, cat, curl -v, error output) can leak the value into the transcript, files, or the network. Only inject into commands you trust with the real secret.`,
				],
				accent: "warning",
				timeoutMs: 30_000,
				choices: [
					{ value: "yes", label: "Inject", description: "Resolve and run" },
					{ value: "no", label: "Deny", description: "Block the tool call" },
				],
			});

			if (result.action !== "approved") {
				const why = result.action === "timeout" ? "timed out" : "denied by user";
				return { block: true, reason: `[pix-env] secret injection ${why}: ${list}` };
			}

			// Approved — mutate input in place. Later handlers see resolved values.
			inject(event, reg, shell, keys);
			return undefined;
		});
	});
}

/**
 * Apply secret resolution to a tool call's input in place.
 * - bash: prepend an `export KEY='value'` prelude and leave references intact,
 *   so bash performs every expansion form natively (incl. modifiers).
 * - other tools: substitute the raw value directly into the string fields.
 */
function inject(
	event: { toolName: string; input: unknown },
	reg: Map<string, string>,
	shell: boolean,
	keys: readonly string[],
): void {
	if (shell) {
		const input = event.input as { command?: unknown };
		if (typeof input.command === "string") {
			input.command = shellPrelude(keys, reg) + input.command;
			return;
		}
	}
	resolveInput(event.input, reg, shell);
}

/** What the secret flows into, still holding `$KEY` refs (no value leaks into the modal). */
export function secretTarget(input: unknown): string {
	const command = (input as { command?: unknown } | null)?.command;
	return typeof command === "string" ? command : JSON.stringify(input);
}
