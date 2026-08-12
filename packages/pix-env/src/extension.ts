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
import { withAgentBlock } from "@xynogen/pix-runtime";
import { once } from "@xynogen/pix-runtime/once";
import { collectRefs, loadRegistry, resolveInput } from "./lib.ts";

const REF_TAG = "pix-env-secrets";

export default function pixEnvExtension(pi: ExtensionAPI): void {
	once(pi, "pix-env", () => {
		const reg = loadRegistry(process.cwd());
		if (reg.size === 0) return; // nothing to broker

		// ── Advertise key NAMES only (values stay in the registry) ──────────
		pi.on("before_agent_start", (event) => {
			const existing = event.systemPrompt ?? "";
			if (existing.includes(`<${REF_TAG}>`)) return; // idempotent on retry
			const names = [...reg.keys()].sort((a, b) => a.localeCompare(b)).join(", ");
			const body =
				`Secret env vars available (VALUES HIDDEN). Reference them as $KEY or ` +
				`\${KEY} in any tool argument — the value is injected at run time after ` +
				`user approval, never shown to you: ${names}`;
			const block = `<${REF_TAG}>\n${body}\n</${REF_TAG}>`;
			return { systemPrompt: existing ? `${existing}\n\n${block}` : block };
		});

		// ── Resolve references on every tool call, gated by approval ────────
		pi.on("tool_call", async (event, ctx) => {
			const shell = event.toolName === "bash";
			const keys = collectRefs(event.input, reg);
			if (keys.length === 0) return undefined;

			// Same AFK/YOLO globals pix-sudo honours (set by the optimizer/gate).
			const g = globalThis as { __pixAfk?: boolean; __pixYolo?: boolean };
			const list = keys.sort((a, b) => a.localeCompare(b)).join(", ");

			// AFK (and not YOLO): auto-deny so no secret is injected while away.
			if (g.__pixAfk === true && g.__pixYolo !== true) {
				return { block: true, reason: `[pix-env] secret injection auto-denied (AFK): ${list}` };
			}

			// YOLO: auto-inject without the popup.
			if (g.__pixYolo === true) {
				ctx.ui?.notify?.(`🔑 YOLO — secret auto-injected: ${list}`, "warning");
				resolveInput(event.input, reg, shell);
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
					title: `🔑 Inject secret${keys.length > 1 ? "s" : ""} — ${list}`,
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
			resolveInput(event.input, reg, shell);
			return undefined;
		});
	});
}
