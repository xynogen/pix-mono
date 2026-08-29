/**
 * Simple RTK Integration
 *
 * 1. Injects RTK system prompt (tells model to prefix commands with rtk)
 * 2. Rewrites bash commands to add rtk prefix when model forgets
 * 3. Falls back gracefully if rtk binary is missing
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { canExecute } from "./capability.ts";
import { loadOptValue, saveOptValue } from "./persist.ts";
import type { OptimizerHandle, OptimizerStatus } from "./status.ts";

/**
 * Minimal structural shape of the SDK `tool_call` event we care about.
 * Mirrors `BashToolCallEvent` from the SDK without importing it, so the
 * rewrite logic stays unit-testable with plain objects.
 */
export interface BashCallEvent {
	toolName: string;
	input: { command?: unknown; [k: string]: unknown };
}

/**
 * Pure decision + mutation step for the `tool_call` hook.
 *
 * Given a tool-call event and whether RTK is available, mutate `event.input`
 * in place (the SDK's only supported way to patch tool args) when the command
 * is a rewritable bash command. Returns true if the command was rewritten.
 *
 * Extracted from the hook closure so the integration is directly testable
 * without a live ExtensionAPI.
 */
/**
 * Return the list of sudo sub-commands found in parsed chain segments.
 * Each entry is the full segment body (trimmed) that starts with `sudo`.
 * Operators are excluded. Returns empty array if none found.
 */
export function detectSudoSegments(parts: string[]): string[] {
	return parts
		.filter((p) => !CHAIN_OPERATORS.has(p.trim()))
		.map((p) => p.trim())
		.filter((p) => /^sudo\b/.test(p));
}

/**
 * Build the block reason string shown to the model when a sudo command is
 * intercepted. Directs the model to `sudo_run` when available, otherwise
 * explains the restriction clearly.
 */
export function buildSudoBlockReason(sudoCmds: string[], hasSudoRunTool: boolean): string {
	const list = sudoCmds.map((c) => `  - ${c}`).join("\n");
	if (hasSudoRunTool) {
		return (
			`bash cannot run sudo commands directly. ` +
			`Use the \`sudo_run\` tool instead — it shows the user a confirmation dialog ` +
			`and handles authentication securely.\n` +
			`Blocked command(s):\n${list}\n` +
			`Strip the leading \`sudo\` from the command and pass the rest to \`sudo_run\` ` +
			`with a clear \`reason\` parameter.`
		);
	}
	return (
		`bash cannot run sudo commands in this session — ` +
		`no sudo_run tool is available and direct sudo is not permitted.\n` +
		`Blocked command(s):\n${list}\n` +
		`Ask the user to run the command manually with elevated privileges.`
	);
}

export function applyRtkRewrite(
	event: BashCallEvent,
	opts: { enabled: boolean; rtkAvailable: boolean },
): boolean {
	if (!opts.enabled) return false;
	if (!opts.rtkAvailable) return false;
	if (event.toolName !== "bash") return false;

	const command = event.input?.command;
	if (typeof command !== "string" || !command) return false;

	const rewritten = rewriteChain(command);
	if (rewritten === command) return false;

	event.input.command = rewritten;
	return true;
}

// Commands that should be prefixed with rtk
const RTK_COMMANDS = new Set([
	"git",
	"gh",
	"ls",
	"tree",
	"grep",
	"cat",
	"head",
	"tail",
	"tsc",
	"lint",
	"eslint",
	"prettier",
	"next",
	"cargo",
	"rustc",
	"vitest",
	"playwright",
	"jest",
	"test",
	"pnpm",
	"npm",
	"npx",
	"yarn",
	"bun",
	"docker",
	"kubectl",
	"aws",
	"psql",
	"wc",
	"prisma",
	"dotnet",
]);

interface RtkStatus {
	available: boolean;
	checkedAt: number;
}

/** Probe the command we actually use instead of relying on a platform-specific locator. */
export function probeRtkAvailability(pi: Pick<ExtensionAPI, "exec">): Promise<boolean> {
	return canExecute(pi, "rtk", ["--version"]);
}

/**
 * Split a command line into segments at top-level shell operators
 * (&&, ||, ;, |), keeping the operators as their own tokens. Operators
 * inside single/double quotes are ignored.
 *
 * Returns null if the parser hits something it can't safely reason about
 * (unbalanced quotes), so the caller can skip rewriting.
 */
export function splitChain(command: string): string[] | null {
	const out: string[] = [];
	let buf = "";
	let quote: "'" | '"' | null = null;

	for (let i = 0; i < command.length; i++) {
		const c = command[i] ?? "";
		const next = command[i + 1];

		if (quote) {
			buf += c;
			if (c === quote) quote = null;
			continue;
		}

		if (c === "'" || c === '"') {
			quote = c;
			buf += c;
			continue;
		}

		// two-char operators
		if ((c === "&" && next === "&") || (c === "|" && next === "|")) {
			out.push(buf, c + c);
			buf = "";
			i++;
			continue;
		}

		// single-char operators
		if (c === ";" || c === "|") {
			out.push(buf, c);
			buf = "";
			continue;
		}

		buf += c;
	}

	if (quote) return null; // unbalanced quote — bail out
	out.push(buf);
	return out;
}

const CHAIN_OPERATORS = new Set(["&&", "||", ";", "|"]);

/**
 * Prefix each command segment with `rtk` when its first word is a known
 * RTK command and it is not already prefixed. Operators are preserved.
 * Returns the rewritten command, or the original if nothing changed.
 */
export function rewriteChain(command: string): string {
	const parts = splitChain(command);
	if (!parts) return command; // unparseable — leave untouched

	let changed = false;
	const rewritten = parts.map((part) => {
		if (CHAIN_OPERATORS.has(part.trim())) return part;

		const leading = part.match(/^\s*/)?.[0] ?? "";
		const body = part.slice(leading.length);
		if (!body) return part;

		const firstWord = body.split(/\s+/)[0] ?? "";
		if (firstWord === "rtk") return part;
		if (!RTK_COMMANDS.has(firstWord)) return part;

		changed = true;
		return `${leading}rtk ${body}`;
	});

	return changed ? rewritten.join("") : command;
}

export function rtk(pi: ExtensionAPI, status: OptimizerStatus): OptimizerHandle {
	let rtkStatus: RtkStatus | null = null;
	let warnedMissing = false;
	let enabled = true;
	// Tracks whether pix-sudo's sudo_run tool is active this session.
	// Set from before_agent_start selectedTools; defaults to false until known.
	let hasSudoRunTool = false;

	// Report into the shared optimizer indicator. RTK counts as "on" only when
	// enabled AND the binary is actually available.
	function syncStatus(ctx: Pick<ExtensionContext, "ui">) {
		status.set("rtk", enabled && rtkStatus?.available === true, ctx);
	}

	// Check if rtk binary is available
	const checkRtkAvailability = async (): Promise<RtkStatus> => {
		// Cache for 60 seconds
		if (rtkStatus && Date.now() - rtkStatus.checkedAt < 60000) {
			return rtkStatus;
		}

		const available = await probeRtkAvailability(pi);
		rtkStatus = {
			available,
			checkedAt: Date.now(),
		};
		if (available) warnedMissing = false;
		return rtkStatus;
	};

	// Detect sudo_run tool availability. No system-prompt injection — the
	// tool_call rewrite hook adds the rtk prefix on its own, so we keep zero
	// always-on context cost (ponytail: manual `rtk err`/`rtk summary`/`rtk
	// test` subcommands are no longer advertised to the model; re-add a prompt
	// here if you want those surfaced).
	pi.on("before_agent_start", (event) => {
		const tools: string[] = event.systemPromptOptions?.selectedTools ?? [];
		hasSudoRunTool = tools.includes("sudo_run");
		return undefined;
	});

	// Keep the status indicator in sync across the agent lifecycle. Probe
	// availability on session start so the icon reflects reality immediately.
	pi.on("session_start", async (_event, ctx) => {
		// Restore the user's on/off choice from disk (survives quit/restart).
		const saved = loadOptValue("rtk");
		if (saved === "on" || saved === "off") enabled = saved === "on";
		const probe = await checkRtkAvailability();
		if (!probe.available && !warnedMissing) {
			ctx.ui.notify(
				"rtk not found — RTK rewriting disabled. Install: cargo install rtk-ai",
				"warning",
			);
			warnedMissing = true;
		}
		syncStatus(ctx);
	});
	pi.on("agent_start", async (_event, ctx) => {
		syncStatus(ctx);
	});
	pi.on("agent_end", async (_event, ctx) => {
		syncStatus(ctx);
	});

	// -- Overlay value handler (called by the /optimizer overlay) --

	async function run(value: string, ctx: ExtensionCommandContext): Promise<void> {
		enabled = value === "on";
		saveOptValue("rtk", enabled ? "on" : "off");

		await checkRtkAvailability();
		syncStatus(ctx);
		ctx.ui.notify(`RTK rewriting ${enabled ? "on" : "off"}.`, "info");
	}

	// Rewrite bash commands to add rtk prefix.
	//
	// The SDK fires a single `tool_call` event for every tool. The bash variant
	// carries `event.toolName === "bash"` and a mutable `event.input` of shape
	// `{ command: string; timeout?: number }`. Arguments are patched by mutating
	// `event.input` IN PLACE — returning `{ toolInput: ... }` does nothing.
	pi.on("tool_call", async (event, ctx) => {
		if (!enabled) {
			return undefined;
		}

		if (event.toolName !== "bash") {
			return undefined;
		}

		const probe = await checkRtkAvailability();

		if (!probe.available) {
			return undefined; // Don't rewrite if rtk not available
		}

		// First confirmed-available probe may have flipped state — refresh icon.
		syncStatus(ctx);

		// Block sudo segments before rtk rewriting.
		// splitChain is safe to call here — same parser used by rewriteChain.
		const command = event.input?.command;
		if (typeof command === "string" && command) {
			const parts = splitChain(command);
			if (parts) {
				const sudoCmds = detectSudoSegments(parts);
				if (sudoCmds.length > 0) {
					const reason = buildSudoBlockReason(sudoCmds, hasSudoRunTool);
					return { block: true, reason };
				}
			}
		}

		// Rewrite every segment in the command chain that uses a known RTK
		// command (e.g. `git add . && git push` -> `rtk git add . && rtk git push`).
		// Mutates `event.input.command` in place — the SDK's supported patch path.
		applyRtkRewrite(event, { enabled, rtkAvailable: probe.available });
		return undefined;
	});

	return {
		name: "rtk",
		help: "rtk — prefix shell commands with rtk (token-optimized)",
		values: ["off", "on"],
		current: () => (enabled ? "on" : "off"),
		run,
	};
}
