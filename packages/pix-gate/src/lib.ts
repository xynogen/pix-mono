/**
 * Pure helpers for pix-gate — no Pi API deps, fully unit-testable.
 */

import type { EventBus } from "@earendil-works/pi-coding-agent";
import { getUnattendedMode } from "@xynogen/pix-runtime";
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

// Recursive delete of a drive root or the user profile (cmd.exe `rd /s`, PowerShell `-Recurse`).
const WINDOWS_ROOT_WIPE =
	/\b(?:rd|rmdir|del|erase|Remove-Item|ri|rm)\b(?=[^|;\n]*\s(?:\/s|-r\w*)\b)[^|;\n]*\s["']?(?:[A-Za-z]:|~|\$env:USERPROFILE|%USERPROFILE%|\$HOME)[\\/]?["']?(?=\s|$|[;|&])/i;

// Command position: line start, after an operator / subshell / quote, or after a
// wrapper (`sudo`, `env`, `xargs`, …). Keeps `grep shutdown src/` and `echo mkfs`
// from matching. `\|` is an escaped pipe inside a pattern, not an operator. A quote
// starts a command only after `-c` (`sh -c "…"`), not in `git commit -m "reboot"`.
const AT_CMD = String.raw`(?:^|(?<!\\)[;&|({\x60!]|\$\(|-c\s+["'])\s*(?:(?:sudo|doas|env|nohup|time|exec|nice|xargs|command|builtin|then|do|else)\s+(?:-\S+\s+)*)*`;
const at = (body: string, flags = "i"): RegExp => new RegExp(AT_CMD + body, flags);

// One shell segment (stops at the next operator).
const SEG = String.raw`[^;&|\n]*`;
// `rm` with a recursive flag (-r, -R, -rf, -fr, --recursive). Force is irrelevant for a non-tty agent.
const RM_R = String.raw`rm\b(?=${SEG}\s(?:-[a-z]*r[a-z]*|--recursive)(?=\s|$))`;
// A target that is `/`, `~`, `$HOME`, or everything under them.
const ROOT_TARGET = String.raw`${SEG}\s["']?(?:\/\*?|~\/?\*?|\$\{?HOME\}?\/?\*?)["']?(?=\s|$|[;&|])`;
// A target that is a top-level system directory.
const SYS_TARGET = String.raw`${SEG}\s["']?\/(?:bin|boot|dev|etc|home|lib|lib64|opt|proc|root|sbin|srv|sys|usr|var)\/?\*?["']?(?=\s|$|[;&|])`;
const RAW_DISK = String.raw`\/dev\/(?:sd|nvme|disk|hd|vd|xvd|mmcblk)`;

const RM_ROOT = at(RM_R + ROOT_TARGET);

export const DEFAULT_RULES: Rule[] = [
	// CRITICAL — destructive, irreversible, or system-wide
	{ pattern: RM_ROOT, severity: "critical", reason: "recursive rm on / or $HOME" },
	{
		pattern: at(RM_R + SYS_TARGET),
		severity: "critical",
		reason: "recursive rm on a system directory",
	},
	{
		pattern: at(String.raw`(?:mkfs(?:\.\w+)?|wipefs|blkdiscard)\b`),
		severity: "critical",
		reason: "filesystem format / wipe",
	},
	{
		pattern: new RegExp(String.raw`\bdd\b[^\n]*\bof=${RAW_DISK}`, "i"),
		severity: "critical",
		reason: "dd to raw block device",
	},
	{
		pattern: new RegExp(String.raw`>\s*${RAW_DISK}`, "i"),
		severity: "critical",
		reason: "writing to raw block device",
	},
	{
		pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/,
		severity: "critical",
		reason: "fork bomb",
	},
	{
		pattern: at(
			String.raw`(?:shutdown|reboot|halt|poweroff|systemctl\s+(?:poweroff|reboot|halt|kexec)|init\s+[06])\b`,
		),
		severity: "critical",
		reason: "system power command",
	},

	// DANGEROUS — destructive or privileged but recoverable in scope
	{ pattern: at(RM_R), severity: "dangerous", reason: "recursive remove" },
	{
		pattern: at(String.raw`(?:sudo|doas|pkexec|su)\b`),
		severity: "dangerous",
		reason: "privilege escalation",
	},
	{
		pattern: at(String.raw`chmod\b${SEG}\s(?:[0-7]?0?777|[ugo]*a[ugo]*\+[rx]*w|o\+[rx]*w|a=rwx)`),
		severity: "dangerous",
		reason: "world-writable permissions",
	},
	{
		pattern: at(
			String.raw`(?:chmod|chown|chgrp)\s+(?:-\S+\s+)*-[a-z]*R(?:${SYS_TARGET}|${ROOT_TARGET})`,
		),
		severity: "dangerous",
		reason: "recursive permission / owner change on a system path",
	},
	{
		pattern:
			/\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:sh|bash|zsh|dash|ksh|fish|python[\d.]*|perl|ruby|node|bun|deno)\b|(?:^|\s)(?:sh|bash|zsh|dash|ksh|eval|source|\.)\s[^\n]*(?:\$\(|<\(|\x60)\s*(?:curl|wget)\b/i,
		severity: "dangerous",
		reason: "remote script execution (curl|sh)",
	},
	{
		// Case-sensitive: `branch -D` force-deletes, `branch -d` does not.
		pattern: new RegExp(
			String.raw`\bgit\b${SEG}\s(?:push\b${SEG}\s(?:-f|--force(?:-with-lease)?|--mirror|--delete|-d|\+\S+|:\S+)(?=\s|$)|reset\s+--hard|clean\s+-[a-zA-Z]*f|branch\s+(?:${SEG}\s)?(?:-D|--delete\s+--force)\b|filter-branch|filter-repo|reflog\s+expire|update-ref\s+-d)`,
		),
		severity: "dangerous",
		reason: "destructive git operation",
	},
	{
		pattern: new RegExp(
			String.raw`\b(?:(?:npm|pnpm|yarn|bun)\s+(?:publish|unpublish|deprecate)|cargo\s+(?:publish|yank)|twine\s+upload|gem\s+push)\b(?!${SEG}--dry-run)`,
			"i",
		),
		severity: "dangerous",
		reason: "package publish",
	},
	{
		pattern: new RegExp(
			String.raw`\bdocker\s+(?:system\s+prune|volume\s+(?:rm|prune)|(?:rm|rmi)\s+-[a-z]*f|image\s+prune\s+-a)|\bdocker(?:\s+compose|-compose)\s+down\b${SEG}\s(?:-v|--volumes)\b`,
			"i",
		),
		severity: "dangerous",
		reason: "destructive docker operation",
	},
	{
		pattern: new RegExp(String.raw`\bfind\b${SEG}\s(?:-delete\b|-exec(?:dir)?\s+rm\b)`, "i"),
		severity: "dangerous",
		reason: "find with delete",
	},
	{
		pattern: at(
			String.raw`(?:crontab\s+-r|kubectl\s+delete|helm\s+(?:uninstall|delete)|terraform\s+destroy|mv\b${SEG}\s\/dev\/null)\b`,
		),
		severity: "dangerous",
		reason: "destructive infra / scheduler operation",
	},
	{
		pattern: /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i,
		severity: "dangerous",
		reason: "destructive SQL",
	},
	{
		pattern: /\bkill\s+-9\s+-1\b/i,
		severity: "dangerous",
		reason: "kill all processes",
	},

	// Windows — cmd.exe and PowerShell forms (Pi's built-in `powershell` tool, Git Bash)
	{
		pattern: WINDOWS_ROOT_WIPE,
		severity: "critical",
		reason: "recursive delete of drive root / profile",
	},
	{
		pattern:
			/\b(Format-Volume|Clear-Disk|Initialize-Disk|diskpart)\b|\bformat(\.com)?\s+[A-Za-z]:/i,
		severity: "critical",
		reason: "disk format / wipe (Windows)",
	},
	{
		pattern: /\bvssadmin\b[^|;\n]*\bdelete\b|\bwmic\b[^|;\n]*\bshadowcopy\b[^|;\n]*\bdelete\b/i,
		severity: "critical",
		reason: "delete shadow copies (restore points)",
	},
	{
		pattern: /\b(Stop-Computer|Restart-Computer)\b/i,
		severity: "critical",
		reason: "system power command (PowerShell)",
	},
	// PowerShell accepts abbreviated params: -r/-rec/-Recurse, -fo/-Force
	{
		pattern:
			/\b(Remove-Item|ri|rm|rmdir|rd|del|erase)\b(?=[^|;\n]*\s-r\w*\b)(?=[^|;\n]*\s-fo\w*\b)/i,
		severity: "dangerous",
		reason: "recursive force remove (PowerShell)",
	},
	{
		pattern: /\b(rd|rmdir|del|erase)\b[^|;\n]*\s\/s\b/i,
		severity: "dangerous",
		reason: "recursive remove (cmd.exe /s)",
	},
	{
		pattern:
			/\breg(\.exe)?\s+(delete|add|import|restore)\b|\b(Remove-Item|Remove-ItemProperty|Set-ItemProperty|New-ItemProperty|Set-Item|New-Item)\b[^|;\n]*\bHK(LM|CU|CR|U|CC):/i,
		severity: "dangerous",
		reason: "registry write",
	},
	{
		pattern: /\bbcdedit\b|\bcipher\b[^|;\n]*\/w\b/i,
		severity: "dangerous",
		reason: "boot config / free-space wipe",
	},
	{
		pattern:
			/\bSet-MpPreference\b[^|;\n]*-Disable|\bAdd-MpPreference\b[^|;\n]*-Exclusion|\bnetsh\b[^|;\n]*\b(state\s+off|opmode\s+disable)\b|\bSet-NetFirewallProfile\b[^|;\n]*-Enabled\s+(\$?false|0)\b/i,
		severity: "dangerous",
		reason: "disable Defender / firewall",
	},
	{
		pattern:
			/\bicacls\b[^|;\n]*\/grant\b[^|;\n]*\b(Everyone|\*S-1-1-0)\b|\b(takeown|icacls)\b[^|;\n]*\s\/(r|t)\b/i,
		severity: "dangerous",
		reason: "recursive / world ACL change (Windows)",
	},
	{
		pattern: /\bnet\s+(user|localgroup)\b[^|;\n]*\/(add|delete)\b/i,
		severity: "dangerous",
		reason: "local user / group change",
	},
	{
		pattern: /\bsc(\.exe)?\s+(delete|config)\b|\bRemove-Service\b/i,
		severity: "dangerous",
		reason: "service delete / reconfigure",
	},
	{
		pattern: /\bwevtutil\s+cl\b|\bClear-EventLog\b/i,
		severity: "dangerous",
		reason: "clear event logs",
	},
	{
		// -e/-ec/-en/-enc/-EncodedCommand; not -ExecutionPolicy
		pattern: /\b(powershell|pwsh)(\.exe)?\b[^|;\n]*\s-(e|ec|en|enc\w*)\b/i,
		severity: "dangerous",
		reason: "encoded PowerShell command",
	},
	{
		pattern:
			/\bcertutil\b[^|;\n]*-urlcache|\bbitsadmin\b[^|;\n]*\/transfer|\bmshta\b[^|;\n]*https?:/i,
		severity: "dangerous",
		reason: "download via system binary (LOLBin)",
	},
	{
		pattern:
			/\b(iex|Invoke-Expression)\b[^\n]*\b(iwr|irm|Invoke-WebRequest|Invoke-RestMethod|DownloadString)\b|\b(iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*\|\s*(iex|Invoke-Expression)\b/i,
		severity: "dangerous",
		reason: "remote script execution (iwr|iex)",
	},
	{
		// runas.exe and Start-Process -Verb RunAs
		pattern: /\brunas\b/i,
		severity: "dangerous",
		reason: "privilege escalation (RunAs)",
	},
	{
		pattern: /\bSet-ExecutionPolicy\b/i,
		severity: "risky",
		reason: "execution policy change",
	},
	{
		pattern: /\btaskkill\b[^|;\n]*\/f\b|\bStop-Process\b[^|;\n]*-fo\w*/i,
		severity: "risky",
		reason: "force-kill process",
	},
	{
		pattern: /\bschtasks\b[^|;\n]*\/create\b|\bRegister-ScheduledTask\b/i,
		severity: "risky",
		reason: "scheduled task (persistence)",
	},

	// RISKY — worth a glance but usually fine
	{
		pattern: /\bgit\s+checkout\s+(-f|--force)/i,
		severity: "risky",
		reason: "force checkout (overwrites local changes)",
	},
	{
		pattern: /\bgit\s+stash\s+(?:drop|clear)\b/i,
		severity: "risky",
		reason: "stash drop / clear",
	},
	{
		pattern: /\bgit\s+(?:checkout|restore)\s+(?:--\s+)?\.(?=\s|$|[;&|])/i,
		severity: "risky",
		reason: "discard all working-tree changes",
	},
	{
		pattern: at(String.raw`(?:chmod|chown|chgrp)\s+(?:-\S+\s+)*-[a-z]*R\b`),
		severity: "risky",
		reason: "recursive permission / owner change",
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
	// `g`/`y` make RegExp.test() stateful (lastIndex), so the same command would
	// match on one call and slip through on the next. Strip them.
	const stateless = (flags: string) => flags.replace(/[gy]/g, "");
	const extra = (cfg.extraRules ?? []).map((r) => ({
		pattern: new RegExp(r.pattern, stateless(r.flags ?? "i")),
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
		pattern: /\.(pem|key|p12|pfx|jks|keystore|ppk)$/i,
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
		pattern: /(^|\/)\.pi\/agent\/auth\.json$/i,
		severity: "block",
		reason: "Pi provider API keys",
	},
	{
		pattern:
			/(^|\/)(\.git-credentials|\.pgpass|\.vault-token|\.kube\/config|\.docker\/config\.json|\.config\/gh\/hosts\.ya?ml)$/i,
		severity: "block",
		reason: "stored credentials / tokens",
	},
	{ pattern: /(^|\/)\.gnupg\//i, severity: "block", reason: "GnuPG keyring" },
	{
		pattern: /(^|\/)(credentials|service-account)\.(json|ya?ml|toml)$/i,
		severity: "block",
		reason: "credentials file",
	},
	// Real .env files hold live secrets — block. Placeholder variants
	// (.env.example/.sample/.template/.dist) carry no secrets, so exclude them.
	{
		pattern: /(^|\/)\.env(?:$|\.(?!example|sample|template|dist)[A-Za-z0-9_-]+)/i,
		severity: "block",
		reason: ".env file (live secrets)",
	},

	// Windows secret stores (paths normalized to `/` in classifyPath)
	{
		pattern: /(^|\/)(System32\/config\/(SAM|SYSTEM|SECURITY)|NTUSER\.DAT)$/i,
		severity: "block",
		reason: "Windows registry hive",
	},
	{
		pattern: /(^|\/)Microsoft\/(Credentials|Protect|Vault)(\/|$)/i,
		severity: "block",
		reason: "Windows credential store / DPAPI keys",
	},
	{
		pattern: /(^|\/)(unattend|autounattend|sysprep)\.xml$/i,
		severity: "block",
		reason: "Windows answer file (plaintext passwords)",
	},

	// warn — yellow allow-first
	{
		pattern: /(^|\/)ConsoleHost_history\.txt$/i,
		severity: "warn",
		reason: "PowerShell history (may hold secrets)",
	},
	{
		pattern: /(^|\/)[A-Za-z]:\/Windows\//i,
		severity: "warn",
		reason: "Windows system directory",
		ops: ["write"],
	},
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
	// Windows paths use `\`. Rules match on `/`.
	const p = path.replace(/\\/g, "/");
	const order: PathSeverity[] = ["block", "warn", "info"];
	for (const sev of order) {
		const hit = rules.find((r) => {
			if (r.severity !== sev) return false;
			if (r.ops && !r.ops.includes(op)) return false;
			return r.pattern.test(p);
		});
		if (hit) return hit;
	}
	return undefined;
}

/** Extract candidate file paths from a bash command string */
export function extractPathsFromBash(command: string): string[] {
	// ponytail: `\` → `/` also rewrites bash escapes (`a\ b`). That only loosens path detection.
	const cmd = command.replace(/\\/g, "/");
	const out: string[] = [];
	const re =
		/(?:^|[\s=><|;&"'`(])((?:\.\.\/|\.\/|\/|~\/|[A-Za-z]:\/|\$env:\w+\/|%\w+%\/|\$\{?\w+\}?\/|\.[A-Za-z0-9_-]+\/)[^\s"'`<>|;&)]+|(?:\.env(?:\.[A-Za-z0-9_-]+)?|[A-Za-z0-9_./-]+\.(?:pem|key|p12|pfx|ppk|crt|cer|env|envrc|netrc)|(?:[A-Za-z0-9_.-]+\/)*(?:credentials|service-account|secrets?)\.(?:json|ya?ml|toml))(?![A-Za-z0-9]))/g;
	for (const m of cmd.matchAll(re)) out.push(m[1] ?? "");
	return out;
}

/** Blank out quoted strings, so `git commit -m "drop sudo"` holds no `sudo` token. */
function stripQuoted(command: string): string {
	return command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
}

/** True when command contains a real sudo invocation (not a path like pix-sudo, not quoted text). */
export function isSudoCommand(command: string): boolean {
	return /(^|[\s;|&(])sudo\b/i.test(stripQuoted(command));
}

/**
 * True when a command invokes the `ssh` remote shell as a token. Requires
 * trailing whitespace/end so it does NOT match `ssh-keygen`, `ssh-add`,
 * `ssh-copy-id`, or `sshpass` (a later real ` ssh ` in the same line still
 * matches, e.g. `sshpass -p x ssh host`).
 */
export function isSshCommand(command: string): boolean {
	return /(^|[\s;|&(])ssh(\s|$)/i.test(stripQuoted(command));
}

// Non-lifting circuit breaker: catastrophic, unrecoverable commands that NO
// mode (not even YOLO) may auto-approve. Mirrors Claude Code's bypassPermissions
// floor, which still prompts on root/home wipes. These always fall through to
// the interactive dialog (or a no-UI block).
const CIRCUIT_BREAKER: RegExp[] = [
	RM_ROOT, // rm -rf /  rm -rf ~/*  rm -r $HOME
	new RegExp(String.raw`\bdd\b[^\n]*\bof=${RAW_DISK}`, "i"), // dd onto a raw disk
	/\bmkfs\.\w+\s+\/dev\//i, // format a device
	/:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, // classic fork bomb
	new RegExp(String.raw`>\s*${RAW_DISK}`, "i"), // redirect over a raw disk
	/\b(?:Format-Volume|Clear-Disk|diskpart)\b|\bformat(?:\.com)?\s+[A-Za-z]:/i, // Windows disk format / wipe
	WINDOWS_ROOT_WIPE, // rd /s C:\  or  Remove-Item -Recurse $env:USERPROFILE
];

/**
 * True when a user `autoApprove` pattern may skip the gate. It covers one simple
 * command only: `^git status` must not approve `git status; rm -rf ~`. It never
 * lifts the circuit breaker.
 */
export function canAutoApprove(command: string, patterns: RegExp[]): boolean {
	if (isCircuitBreaker(command) || /[;&|`\n<>]|\$\(/.test(command)) return false;
	return patterns.some((re) => re.test(command));
}

/** True when a command is catastrophic enough that no unattended mode may auto-approve it. */
export function isCircuitBreaker(command: string): boolean {
	return CIRCUIT_BREAKER.some((re) => re.test(command));
}

/**
 * Unattended-mode gate decision for a concern tier (1 risky … 5 critical).
 *   yolo — auto-allow every tier, including red/critical.
 *   afk  — auto-allow yellow (tier < 4), auto-deny red (tier >= 4).
 *   off  — undefined (fall through to the interactive dialog).
 */
export function unattendedGateDecision(
	events: EventBus,
	tier: number,
): "allow" | "deny" | undefined {
	const mode = getUnattendedMode(events);
	if (mode === "yolo") return "allow";
	if (mode === "afk") return tier >= 4 ? "deny" : "allow";
	return undefined;
}
