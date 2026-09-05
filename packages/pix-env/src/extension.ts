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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { showOverlay } from "@xynogen/pix-pretty/gate-overlay";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { getUnattendedMode, withAgentBlock } from "@xynogen/pix-runtime";
import { once } from "@xynogen/pix-runtime/once";
import {
	allRefsIn,
	collectRefs,
	collectUnsupported,
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
					title: `🔑 Inject Secret${keys.length > 1 ? "s" : ""} — ${list}`,
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
