/**
 * pix-gate — Pi extension
 *
 * Intercepts bash `tool_call` events and gates dangerous commands behind a
 * TUI confirmation dialog before they run.
 *
 * Severity tiers (user always has final say via dialog):
 *   critical  — red, deny-first dialog
 *   dangerous — yellow, deny-first dialog
 *   risky     — allow-first dialog
 *   sudo      — hard block, must use sudo_run tool instead (no bypass)
 *   No-UI fallback: critical/dangerous auto-block (can't show dialog)
 *
 * Config: ~/.pi/agent/pix.json (the `gate` section)
 *   guardrails: "off"              — disable built-in rules entirely
 *   extraRules: [{ pattern, flags?, severity?, reason? }]  — append extra rules
 *   autoApprove: ["regex"]         — bypass gate for matching commands
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withAgentBlock } from "@xynogen/pix-runtime";
import {
	buildRules,
	classify,
	classifyPath,
	extractPathsFromBash,
	isCircuitBreaker,
	isSudoCommand,
	loadUserConfig,
	unattendedGateDecision,
} from "./lib.ts";
import {
	type Concern,
	type GateDecision,
	PATH_SEVERITY_ICON,
	promptGateDecision,
	promptMergedGateDecision,
	promptPathDecision,
	SEVERITY_ICON,
} from "./prompt.ts";

export default function (pi: ExtensionAPI): void {
	const { rules, autoApprove, pathRules } = buildRules(loadUserConfig());

	// ── Path protection (read/write/edit tools only — bash handled below) ───
	pi.on("tool_call", async (event, ctx) => {
		const tool = String(event.toolName);
		const input = event.input as Record<string, unknown>;

		// bash is handled by the unified gate below
		if (tool === "bash") return undefined;

		let path: string | undefined;
		let op: "read" | "write";

		if (tool === "read") {
			path = String(input.path ?? "");
			op = "read";
		} else if (tool === "write" || tool === "edit") {
			path = String(input.path ?? "");
			op = "write";
		} else {
			return undefined;
		}

		if (!path) return undefined;
		const hit = classifyPath(path, op, pathRules);
		if (!hit) return undefined;

		if (hit.severity === "info") {
			ctx.ui.notify(`${PATH_SEVERITY_ICON.info} ${hit.reason}: ${path}`, "info");
			return undefined;
		}

		const unattended = unattendedGateDecision(hit.severity === "block" ? 4 : 2);
		if (unattended === "allow") return undefined;
		if (unattended === "deny") {
			return {
				block: true,
				reason: `[AFK][PATH:${hit.severity.toUpperCase()}] ${hit.reason}`,
			};
		}

		if (!ctx.hasUI)
			return {
				block: true,
				reason: `[PATH:${hit.severity.toUpperCase()}] ${hit.reason} (no UI)`,
			};

		const decision = await withAgentBlock(
			pi.events,
			"gate",
			`${hit.severity.toUpperCase()} path approval required`,
			() => promptPathDecision(ctx.ui, hit, op, path),
		);
		if (!decision.approved)
			return {
				block: true,
				reason: `[PATH] ${decision.reason}: ${hit.reason}`,
			};
		return undefined;
	});

	// ── Unified bash gate (path + command concerns in ONE dialog) ───────────
	const SEVERITY_TIER: {
		critical: number;
		block: number;
		dangerous: number;
		warn: number;
		risky: number;
	} = {
		critical: 5,
		block: 4,
		dangerous: 3,
		warn: 2,
		risky: 1,
	};

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = String(event.input.command ?? "");
		if (!command.trim()) return undefined;

		// Collect all concerns: path hits + command hit
		const concerns: Concern[] = [];

		// Path concerns
		const candidates = extractPathsFromBash(command);
		for (const p of candidates) {
			const hit = classifyPath(p, "read", pathRules);
			if (!hit) continue;
			if (hit.severity === "info") {
				ctx.ui.notify(`${PATH_SEVERITY_ICON.info} ${hit.reason}: ${p}`, "info");
				continue;
			}
			concerns.push({
				icon: PATH_SEVERITY_ICON[hit.severity],
				label: hit.severity.toUpperCase(),
				detail: `${hit.reason} — ${p}`,
				tier: SEVERITY_TIER[hit.severity] ?? 0,
			});
		}

		// Command concern
		const cmdHit = classify(command, rules);
		if (cmdHit) {
			concerns.push({
				icon: SEVERITY_ICON[cmdHit.severity],
				label: cmdHit.severity.toUpperCase(),
				detail: cmdHit.reason,
				tier: SEVERITY_TIER[cmdHit.severity] ?? 0,
			});
		}

		if (concerns.length === 0) return undefined;

		const highest = concerns.reduce((a, b) => (a.tier > b.tier ? a : b));

		// sudo: hard redirect — no prompt, no bypass. Even YOLO cannot run bare
		// `sudo` in bash (the password can't be auto-typed); it must use sudo_run.
		if (isSudoCommand(command)) {
			if (unattendedGateDecision(highest.tier) === "deny") {
				return { block: true, reason: "[AFK] sudo is denied while user is away." };
			}
			ctx.ui.notify(
				`⚠️  ${ctx.ui.theme.fg("warning", "DANGEROUS")} — use sudo_run tool instead (handles auth securely)`,
				"warning",
			);
			return {
				block: true,
				reason: "Use sudo_run tool instead of sudo in bash.",
			};
		}

		// Circuit breaker: catastrophic commands never auto-approve, even under YOLO.
		// They fall through to the interactive dialog (or the no-UI block below).
		const breaker = isCircuitBreaker(command);
		if (breaker && unattendedGateDecision(highest.tier) === "allow") {
			ctx.ui.notify(
				`⛔ ${ctx.ui.theme.fg("error", "CIRCUIT BREAKER")} — refused even under YOLO; confirm manually`,
				"error",
			);
		}
		const unattended = breaker ? undefined : unattendedGateDecision(highest.tier);
		if (unattended === "allow") return undefined;
		if (unattended === "deny") {
			return {
				block: true,
				reason: `[AFK][${highest.label}] ${highest.detail}`,
			};
		}

		if (autoApprove.some((re) => re.test(command))) return undefined;

		// No UI: auto-block block+ severity, pass anything lower.
		if (!ctx.hasUI) {
			if (highest.tier >= SEVERITY_TIER.block) {
				return {
					block: true,
					reason: `[${highest.label}] ${highest.detail} (no UI, auto-blocked)`,
				};
			}
			return undefined;
		}

		// Single concern → use existing targeted dialog. Multiple → merged.
		let decision: GateDecision;
		if (concerns.length === 1 && cmdHit) {
			decision = await withAgentBlock(
				pi.events,
				"gate",
				`${highest.label} command approval required`,
				() => promptGateDecision(ctx.ui, cmdHit, command),
			);
		} else if (concerns.length === 1 && !cmdHit) {
			// Single path hit — reuse path dialog
			const ph = candidates
				.map((p) => ({ p, h: classifyPath(p, "read", pathRules) }))
				.find((x) => x.h?.severity !== "info" && x.h);
			if (ph?.h) {
				decision = await withAgentBlock(
					pi.events,
					"gate",
					`${highest.label} path approval required`,
					() => promptPathDecision(ctx.ui, ph.h as NonNullable<typeof ph.h>, "bash read", ph.p),
				);
			} else {
				return undefined;
			}
		} else {
			decision = await withAgentBlock(
				pi.events,
				"gate",
				`${highest.label} command approval required`,
				() => promptMergedGateDecision(ctx.ui, concerns, command),
			);
		}

		if (!decision.approved) {
			ctx.ui.notify(`${highest.icon} ${decision.reason}: ${highest.detail}`, "warning");
			return { block: true, reason: `[${highest.label}] ${decision.reason}` };
		}

		const severityColor =
			highest.tier >= SEVERITY_TIER.block
				? "error"
				: highest.tier >= SEVERITY_TIER.dangerous
					? "warning"
					: "accent";
		ctx.ui.notify(
			`${highest.icon} ` +
				ctx.ui.theme.fg(severityColor, `Approved ${highest.label.toLowerCase()} command`),
			"info",
		);
		return undefined;
	});
}
