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

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { showOverlay } from "@xynogen/pix-pretty/gate-overlay";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import {
	formatCollapsedToolRow,
	formatToolCallTitle,
	frameToolResult,
	getTextContent,
	hideCollapsedToolCall,
} from "@xynogen/pix-pretty/utils";
import { getUnattendedMode, withAgentBlock } from "@xynogen/pix-runtime";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";
import { once } from "@xynogen/pix-runtime/once";
import { Type } from "typebox";
import {
	allRefsIn,
	collectRefs,
	collectUnsupported,
	describeRegistry,
	loadPath,
	loadRegistry,
	resolveInput,
	shellPrelude,
} from "./lib.ts";

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
			label: "Read Environment",
			description:
				'Read loaded .env data with minimal disclosure. action="info" returns variable names and inferred shapes only, without approval. action="read" returns only requested names after explicit user approval. Never request unrelated variables.',
			promptSnippet: "Inspect env names/shapes or request specific values with user approval",
			parameters: Type.Object({
				action: StringEnum(["info", "read"] as const, {
					description:
						'"info" lists names and inferred shapes; "read" reveals requested values after approval.',
				}),
				path: Type.Optional(
					Type.String({
						description:
							"Optional .env file or directory to load. Defaults to the configured files under the current directory.",
					}),
				),
				names: Type.Optional(
					Type.Array(Type.String(), {
						description: 'Exact variable names to reveal. Required for action="read".',
						minItems: 1,
					}),
				),
			}),
			renderShell: "self",
			renderCall(args, theme, context) {
				if (hideCollapsedToolCall(context.state as CollapseState, context.expanded, () => {}))
					return new Text("", 0, 0);
				return new Text(
					`${formatToolCallTitle(theme, "read_env", context)} ${theme.fg("dim", args.action)}`,
					0,
					0,
				);
			},
			renderResult(result, _options, theme, renderCtx) {
				const details = result.details as
					| { action?: string; types?: Record<string, "boolean" | "int" | "float" | "string"> }
					| undefined;
				const body =
					details?.action === "info" && details.types
						? Object.entries(details.types)
								.map(
									([name, type]) =>
										`${icon(`data.${type}`)} ${theme.fg("accent", name)} ${theme.fg("muted", type)}`,
								)
								.join("\n")
						: getTextContent(result) || "No env variables loaded.";
				if (
					!_options.isPartial &&
					tickCollapse(
						"read_env",
						renderCtx.state as CollapseState,
						renderCtx.invalidate,
						_options.expanded,
					)
				)
					return new Text(
						formatCollapsedToolRow(
							theme,
							"read_env",
							details?.action ?? "",
							"",
							renderCtx.isError ? "error" : "success",
						),
						0,
						0,
					);
				const text = new Text(body, 0, 0);
				return _options.isPartial ? text : frameToolResult(text, theme, renderCtx.isError);
			},
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const reg = params.path ? loadPath(params.path) : loadRegistry(ctx.cwd);
				if (params.action === "info") {
					const types = describeRegistry(reg);
					const text = Object.entries(types)
						.map(([key, type]) => `${key} = ${type}`)
						.join("\n");
					return {
						content: [{ type: "text", text: text || "No env variables loaded." }],
						details: { action: "info", count: Object.keys(types).length, types },
					};
				}

				const names = [...new Set(params.names?.map((name) => name.trim()).filter(Boolean) ?? [])];
				if (names.length === 0) {
					return {
						content: [
							{ type: "text", text: 'read_env failed: names is required for action="read"' },
						],
						details: { action: "read", revealed: [] },
						isError: true,
					};
				}
				const unknown = names.filter((name) => !reg.has(name));
				if (unknown.length > 0) {
					return {
						content: [
							{
								type: "text",
								text: `read_env failed: unknown env variable(s): ${unknown.join(", ")}`,
							},
						],
						details: { action: "read", revealed: [] },
						isError: true,
					};
				}
				if (!ctx.hasUI) {
					return {
						content: [{ type: "text", text: "read_env requires interactive user approval." }],
						details: { action: "read", revealed: [] },
						isError: true,
					};
				}

				const list = names.sort((a, b) => a.localeCompare(b)).join(", ");
				const result = await withAgentBlock(
					pi.events,
					"read_env",
					"secret disclosure approval",
					() =>
						showOverlay(ctx.ui, {
							mode: "confirm",
							icon: icon("secret"),
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
						}),
				);
				if (result.action !== "approved") {
					return {
						content: [{ type: "text", text: `read_env ${result.action}: ${list}` }],
						details: { action: "read", revealed: [] },
					};
				}

				return {
					content: [
						{
							type: "text",
							text: names.map((name) => `${name}=${reg.get(name) as string}`).join("\n"),
						},
					],
					details: { action: "read", revealed: names },
				};
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
			if (mode === "yolo") {
				ctx.ui?.notify?.(`🔑 YOLO — secret auto-injected: ${list}`, "warning");
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

			const result = await withAgentBlock(pi.events, "pix-env", "secret approval", () =>
				showOverlay(ctx.ui as Parameters<typeof showOverlay>[0], {
					mode: "confirm",
					icon: icon("secret"),
					title: `Inject Secret${keys.length > 1 ? "s" : ""} — ${list}`,
					body: [
						`Tool "${event.toolName}" will receive the real value of: ${list}`,
						"Value is not shown here and stays out of your transcript unless the tool echoes it.",
						`${icon("status.warn")} Warning: a tool that prints or logs its input (echo, cat, curl -v, error output) can leak the value into the transcript, files, or the network. Only inject into commands you trust with the real secret.`,
					],
					accent: "warning",
					timeoutMs: 30_000,
					choices: [
						{ value: "yes", label: "Inject", description: "Resolve and run" },
						{ value: "no", label: "Deny", description: "Block the tool call" },
					],
				}),
			);

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
