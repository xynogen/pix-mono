/**
 * Pure helpers for pix-gate — no Pi API deps, fully unit-testable.
 */

import { config } from "@xynogen/pix-runtime/config";
import { type GateRuleConfig, gateSection } from "@xynogen/pix-runtime/sections";

export type Severity = "critical" | "dangerous" | "risky";

export interface Rule {
	pattern: RegExp;
	severity: Severity;
	reason: string;
}

export interface UserConfig {
	extraRules?: {
		pattern: string;
		flags?: string;
		severity?: Severity;
		reason?: string;
	}[];
	/** Whether Pix's built-in command protections are active. Defaults to "on". */
	guardrails?: "on" | "off";
	/** Regex strings — commands matching any are passed through without prompting. */
	autoApprove?: string[];
}

export const DEFAULT_RULES: Rule[] = [
	// CRITICAL — destructive, irreversible, or system-wide
	{
		pattern: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+\/(\s|$)/i,
		severity: "critical",
		reason: "rm -rf on /",
	},
	{
		pattern: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+(~|\$HOME)(\s|$|\/\s*$)/i,
		severity: "critical",
		reason: "rm -rf on $HOME",
	},
	{
		pattern: /\bmkfs(\.\w+)?\b/i,
		severity: "critical",
		reason: "filesystem formatting",
	},
	{
		pattern: /\bdd\s+.*\bof=\/dev\/(sd[a-z]|nvme|disk)/i,
		severity: "critical",
		reason: "dd to raw block device",
	},
	{
		pattern: />\s*\/dev\/(sd[a-z]|nvme|disk)/i,
		severity: "critical",
		reason: "writing to raw block device",
	},
	{
		pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/,
		severity: "critical",
		reason: "fork bomb",
	},
	{
		pattern: /\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b/i,
		severity: "critical",
		reason: "system power command",
	},

	// DANGEROUS — destructive or privileged but recoverable in scope
	{
		pattern: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i,
		severity: "dangerous",
		reason: "recursive force remove",
	},
	// Match sudo as a command/operator token, not as a substring of path components like pix-sudo
	{
		pattern: /(^|[\s;|&])sudo\b/i,
		severity: "dangerous",
		reason: "privilege escalation",
	},
	{
		pattern: /\b(chmod|chown)\b[^|;&]*\b(777|-R\s+777)/i,
		severity: "dangerous",
		reason: "world-writable permissions",
	},
	{
		pattern: /\bchmod\s+-R\b/i,
		severity: "dangerous",
		reason: "recursive chmod",
	},
	{
		pattern: /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i,
		severity: "dangerous",
		reason: "remote script execution (curl|sh)",
	},
	{
		pattern: /\bgit\s+(push\s+(-f|--force)|reset\s+--hard|clean\s+-[a-z]*f)/i,
		severity: "dangerous",
		reason: "destructive git operation",
	},
	{
		pattern: /\bnpm\s+publish\b/i,
		severity: "dangerous",
		reason: "package publish",
	},
	{
		pattern: /\bdocker\s+(system\s+prune|rm\s+-f|volume\s+rm)/i,
		severity: "dangerous",
		reason: "destructive docker operation",
	},
	{
		pattern: /\bkill\s+-9\s+-1\b/i,
		severity: "dangerous",
		reason: "kill all processes",
	},

	// RISKY — worth a glance but usually fine
	{
		pattern: /\bgit\s+checkout\s+(-f|--force)/i,
		severity: "risky",
		reason: "force checkout (overwrites local changes)",
	},
	{
		pattern: /\bgit\s+stash\s+drop\b/i,
		severity: "risky",
		reason: "stash drop",
	},
	{
		pattern: />\s*[^|&;]*\.env\b/i,
		severity: "risky",
		reason: "writing to .env",
	},
];

export function loadUserConfig(): UserConfig {
	// Read from ~/.pi/agent/pix.json gate section
	const pix = config(gateSection);
	return {
		guardrails: pix.guardrails,
		autoApprove: pix.autoApprove.length > 0 ? pix.autoApprove : undefined,
		extraRules:
			pix.extraRules.length > 0
				? pix.extraRules.map((r: GateRuleConfig) => ({
						pattern: r.pattern,
						flags: r.flags,
						severity: r.severity as Severity | undefined,
						reason: r.reason,
					}))
				: undefined,
	};
}

export function buildRules(cfg: UserConfig): {
	rules: Rule[];
	autoApprove: RegExp[];
	pathRules: PathRule[];
} {
	const base = cfg.guardrails === "off" ? [] : DEFAULT_RULES.slice();
	const extra = (cfg.extraRules ?? []).map((r) => ({
		pattern: new RegExp(r.pattern, r.flags ?? "i"),
		severity: (r.severity ?? "dangerous") as Severity,
		reason: r.reason ?? "user-defined rule",
	}));
	const autoApprove = (cfg.autoApprove ?? []).map((s) => new RegExp(s));
	// ponytail: path rule config extension skipped for now — add extraPathRules/disablePathDefaults to UserConfig when needed
	const pathRules = cfg.guardrails === "off" ? [] : DEFAULT_PATH_RULES.slice();
	return { rules: [...base, ...extra], autoApprove, pathRules };
}

/**
 * Return the highest-severity rule that matches `command`, or undefined if none.
 * Checks critical → dangerous → risky in order, returning on first match.
 */
export function classify(command: string, rules: Rule[]): Rule | undefined {
	const order: Severity[] = ["critical", "dangerous", "risky"];
	for (const sev of order) {
		const hit = rules.find((r) => r.severity === sev && r.pattern.test(command));
		if (hit) return hit;
	}
	return undefined;
}

// ── Path rules ───────────────────────────────────────────────────────────────

export type PathSeverity = "block" | "warn" | "info";

export interface PathRule {
	pattern: RegExp;
	severity: PathSeverity;
	reason: string;
	/** Which ops to intercept: "read" | "write" | both (default both) */
	ops?: ("read" | "write")[];
}

/**
 * block — red, deny-first dialog (user can still allow)
 * warn  — yellow, allow-first dialog
 * info  — blue notify only, always passes through
 */
export const DEFAULT_PATH_RULES: PathRule[] = [
	// block — red deny-first
	{
		pattern: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
		severity: "block",
		reason: "SSH private key",
	},
	{
		pattern: /\.(pem|key|p12|pfx|jks|keystore)$/i,
		severity: "block",
		reason: "private key / keystore",
	},
	{
		pattern: /(^|\/)\.aws\/credentials$/i,
		severity: "block",
		reason: "AWS credentials",
	},
	{
		pattern: /(^|\/)\.netrc$/i,
		severity: "block",
		reason: "netrc credentials",
	},
	{
		pattern: /(^|\/)(credentials|service-account)\.(json|ya?ml|toml)$/i,
		severity: "block",
		reason: "credentials file",
	},

	// warn — yellow allow-first
	{ pattern: /(^|\/)\.env(\.|$)/i, severity: "warn", reason: ".env file" },
	{ pattern: /(^|\/)\.envrc$/i, severity: "warn", reason: "direnv file" },
	{
		pattern: /(^|\/)\.npmrc$/i,
		severity: "warn",
		reason: ".npmrc (may contain auth tokens)",
	},
	{
		pattern: /(^|\/)\.pypirc$/i,
		severity: "warn",
		reason: ".pypirc (may contain tokens)",
	},
	{ pattern: /\.(crt|cer)$/i, severity: "warn", reason: "certificate file" },
	{
		pattern: /(^|\/)(secrets?)\.(json|ya?ml|toml)$/i,
		severity: "warn",
		reason: "secrets file",
	},
	{ pattern: /(^|\/)\.ssh\//i, severity: "warn", reason: ".ssh directory" },

	// info — notify only (write-only guard)
	{
		pattern: /(^|\/)\.git\//,
		severity: "info",
		reason: ".git directory",
		ops: ["write"],
	},
	{
		pattern: /(^|\/)node_modules\//,
		severity: "info",
		reason: "node_modules",
		ops: ["write"],
	},
];

export function classifyPath(
	path: string,
	op: "read" | "write",
	rules: PathRule[],
): PathRule | undefined {
	const order: PathSeverity[] = ["block", "warn", "info"];
	for (const sev of order) {
		const hit = rules.find((r) => {
			if (r.severity !== sev) return false;
			if (r.ops && !r.ops.includes(op)) return false;
			return r.pattern.test(path);
		});
		if (hit) return hit;
	}
	return undefined;
}

/** Extract candidate file paths from a bash command string */
export function extractPathsFromBash(cmd: string): string[] {
	const out: string[] = [];
	const re =
		/(?:^|[\s=><|;&"'`(])((?:\.\.\/|\.\/|\/|~\/)[^\s"'`<>|;&)]+|(?:\.env(?:\.[A-Za-z0-9_-]+)?|[A-Za-z0-9_./-]+\.(?:pem|key|p12|pfx|crt|cer|env|envrc|netrc))(?![A-Za-z0-9]))/g;
	for (const m of cmd.matchAll(re)) out.push(m[1] ?? "");
	return out;
}

/** True when command contains a real sudo invocation (not a path like pix-sudo). */
export function isSudoCommand(command: string): boolean {
	return /(^|[\s;|&])sudo\b/i.test(command);
}
