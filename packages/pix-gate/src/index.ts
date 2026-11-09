/**
 * pix-gate — Pi extension
 *
 * Intercepts shell `tool_call` events (bash, powershell, proc) and gates
 * dangerous commands behind a TUI confirmation dialog before they run. Also
 * gates secret paths for the read/write/edit/grep/find/ls tools.
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
 *   autoApprove: ["regex"]         — bypass gate for matching simple commands
 *                                    (never for chained commands or the circuit breaker)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getUnattendedMode, withAgentBlock } from "@xynogen/pix-runtime";
import {
	buildRules,
	canAutoApprove,
	classify,
	classifyPath,
	extractPathsFromBash,
	isCircuitBreaker,
	isSshCommand,
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
import { registerProjectTrust } from "./trust.ts";

export default function (pi: ExtensionAPI): void {
	// Two-choice project-trust prompt (Trust / Do not trust) replacing Pi's five.
	registerProjectTrust(pi);

	const { rules, autoApprove, pathRules } = buildRules(loadUserConfig());

	// Is a tool registered (active or gated)? ssh_run/sudo_run are opt-in and
	// absent when pix-ssh/pix-sudo aren't installed — only redirect toward a
	// tool that actually exists, else the bash form is the only path.
	const isRegistered = (name: string): boolean => {
		try {
			return (pi.getAllTools?.() ?? []).some((t) => t.name === name);
		} catch {
			return false;
		}
	};

	// Privileged auth tools that must not run raw in bash (interactive password /
	// passphrase can't be auto-typed there). Each redirects to its dedicated tool
	// ONLY when that tool is installed. pix-nudge handles the non-privileged
	// read/ls/grep/find/edit stand-ins.
	const AUTH_REDIRECTS = [
		{ match: isSudoCommand, tool: "sudo_run", label: "sudo" },
		{ match: isSshCommand, tool: "ssh_run", label: "ssh" },
	] as const;

	// ── Path protection (file tools — shell tools handled below) ───
	// grep/find/ls take a directory, so `~/.ssh` also tests as `~/.ssh/`.
	const PATH_TOOLS: Record<string, "read" | "write"> = {
		read: "read",
		grep: "read",
		find: "read",
		ls: "read",
		write: "write",
		edit: "write",
	};
	const DIR_TOOLS = new Set(["grep", "find", "ls"]);
	const PATH_ORDER = { block: 0, warn: 1, info: 2 } as const;
	pi.on("tool_call", async (event, ctx) => {
		if (getUnattendedMode(pi.events) === "nuclear") return undefined;
		const tool = String(event.toolName);
		const op = PATH_TOOLS[tool];
		if (!op) return undefined;
		const input = event.input as Record<string, unknown>;

		// `paths` is the batch form of pix-read / pix-ls.
		const raw = [input.path, input.file_path, ...(Array.isArray(input.paths) ? input.paths : [])];
		const targets = raw.filter((p): p is string => typeof p === "string" && p.length > 0);
		const hits = targets
			.flatMap((p) => (DIR_TOOLS.has(tool) ? [p, `${p.replace(/[\\/]$/, "")}/`] : [p]))
			.map((p) => ({ p, h: classifyPath(p, op, pathRules) }))
			.filter((x): x is { p: string; h: NonNullable<typeof x.h> } => x.h !== undefined)
			.sort((a, b) => PATH_ORDER[a.h.severity] - PATH_ORDER[b.h.severity]);
		const top = hits[0];
		if (!top) return undefined;
		const { p: path, h: hit } = top;

		if (hit.severity === "info") {
			ctx.ui.notify(`${PATH_SEVERITY_ICON.info} ${hit.reason}: ${path}`, "info");
			return undefined;
		}

		const unattended = unattendedGateDecision(pi.events, hit.severity === "block" ? 4 : 2);
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

	// The unified command gate also covers pix-proc's `proc` tool: its `start`
	// action carries a shell command in `event.input.command`, identical to bash.
	// proc's other actions (list/logs/stop/rm) carry no command and pass straight
	// through. Install pix-proc without pix-gate = ungated, same as bash.
	// Pi's built-in `powershell` tool uses the same `input.command` shape.
	const GATED_COMMAND_TOOLS = new Set(["bash", "proc", "powershell"]);
	pi.on("tool_call", async (event, ctx) => {
		if (getUnattendedMode(pi.events) === "nuclear") return undefined;
		const toolName = String(event.toolName);
		if (!GATED_COMMAND_TOOLS.has(toolName)) return undefined;

		const command = String((event.input as Record<string, unknown>).command ?? "");
		if (!command.trim()) return undefined;

		// Collect all concerns: path hits + command hit
		const concerns: Concern[] = [];

		// Path concerns. A redirect or `tee` target counts as a write.
		const candidates = extractPathsFromBash(command);
		const writeTargets = new Set(
			[
				...command
					.replace(/\\/g, "/")
					.matchAll(/(?:>>?|\btee\s+(?:-\S+\s+)*)\s*["']?([^\s"'`;&|<>)]+)/g),
			].map((m) => m[1]),
		);
		const opFor = (p: string): "read" | "write" => (writeTargets.has(p) ? "write" : "read");

		// Steer a blocked ssh-config read toward the dedicated `ssh info` tool
		// (ssh_run action:"info"), which reads the effective config without touching
		// ~/.ssh directly. Only when ssh_run is installed. Appended to the block
		// reason so the model reads it and stops retrying with awk/grep/raw ssh.
		const readsSshConfig = candidates.some((p) => /(^|\/)\.ssh\/config\b/i.test(p));
		const sshInfoSteer =
			readsSshConfig && isRegistered("ssh_run")
				? ' Use the ssh_run tool with action:"info" to read the effective SSH config instead of reading ~/.ssh/config in bash.'
				: "";
		for (const p of candidates) {
			const hit = classifyPath(p, opFor(p), pathRules);
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

		// Privileged auth redirect — hard block, no prompt, no bypass. Even YOLO
		// cannot run bare sudo/ssh in bash (password/passphrase can't be auto-typed);
		// it must use the dedicated tool. Only fires when that tool is installed.
		// Runs before the empty-concerns exit: plain `ssh host` matches no rule.
		for (const redirect of AUTH_REDIRECTS) {
			if (!redirect.match(command) || !isRegistered(redirect.tool)) continue;
			const tier = Math.max(SEVERITY_TIER.dangerous, ...concerns.map((c) => c.tier));
			if (unattendedGateDecision(pi.events, tier) === "deny") {
				return { block: true, reason: `[AFK] ${redirect.label} is denied while user is away.` };
			}
			// One surface only: the block reason renders as the tool-error card and
			// reaches the model. A separate notify would duplicate the warning.
			return {
				block: true,
				reason: `DANGEROUS — use the ${redirect.tool} tool instead of ${redirect.label} in ${toolName} (it handles auth securely).`,
			};
		}

		if (concerns.length === 0) return undefined;

		const highest = concerns.reduce((a, b) => (a.tier > b.tier ? a : b));

		// Circuit breaker: catastrophic commands never auto-approve, even under YOLO.
		// They fall through to the interactive dialog (or the no-UI block below).
		const breaker = isCircuitBreaker(command);
		if (breaker && unattendedGateDecision(pi.events, highest.tier) === "allow") {
			ctx.ui.notify(
				`⛔ ${ctx.ui.theme.fg("error", "CIRCUIT BREAKER")} — refused even under YOLO; confirm manually`,
				"error",
			);
		}
		const unattended = breaker ? undefined : unattendedGateDecision(pi.events, highest.tier);
		if (unattended === "allow") return undefined;
		if (unattended === "deny") {
			return {
				block: true,
				reason: `[AFK][${highest.label}] ${highest.detail}${sshInfoSteer}`,
			};
		}

		if (canAutoApprove(command, autoApprove)) return undefined;

		// No UI: auto-block block+ severity, pass anything lower.
		if (!ctx.hasUI) {
			if (highest.tier >= SEVERITY_TIER.block) {
				return {
					block: true,
					reason: `[${highest.label}] ${highest.detail} (no UI, auto-blocked)${sshInfoSteer}`,
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
				.map((p) => ({ p, h: classifyPath(p, opFor(p), pathRules) }))
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
			return { block: true, reason: `[${highest.label}] ${decision.reason}${sshInfoSteer}` };
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
