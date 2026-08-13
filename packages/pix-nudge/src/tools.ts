/**
 * tools-nudge.ts — nudge the model toward dedicated tools over raw bash
 *
 * Hooks `tool_call` for the built-in `bash` tool. When a bash command merely
 * reimplements a first-class tool (read/ls/grep/find/edit/write), it emits a
 * YELLOW warning notification ONCE per command-category per session — the
 * command still runs. The nudge teaches the model to prefer the dedicated tool
 * next time (better token usage, stricter behavior) WITHOUT blocking: blocking
 * rendered red and forced a failed retry that wasted a turn. After the first
 * nudge for a category, subsequent bash calls in that category are silent (no
 * nag loop). Bash stays available for everything (pipes, compound, real work).
 *
 * IMPORTANT: some target tools (e.g. `ls`, `find`) are GATED from the system
 * prompt — registered but prompt-hidden until the model discovers them via
 * toolbox. They ARE still in the function-calling definitions (always callable).
 * The nudge checks `pi.getActiveTools()` first: if the tool is prompt-visible,
 * recommend it directly; if it is gated, tell the model to enable it via toolbox
 * but note that all tools are always callable via function definitions.
 *
 * The nudge is deliberately SURGICAL: it names only the single tool that maps
 * to the command just blocked. It does NOT dump a full tool inventory — that
 * floods the model with gated tools it can't call and is the opposite of the
 * lazy-gate's purpose (a lean prompt). Point at the one right tool; don't list
 * the menu.
 */

import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";

/** In-bounds array access that satisfies noUncheckedIndexedAccess without casting. */
function at<T>(arr: T[], i: number): T {
	return arr[i] as T;
}

/** Categories that map a raw shell command to a dedicated Pi tool. */
type Category = "read" | "ls" | "grep" | "find" | "edit" | "ssh" | "sudo";

interface Rule {
	category: Category;
	/** Match the *leading* command word(s). */
	test: (cmd: string) => boolean;
	tool: string;
	reason: string;
}

/** First bare word of a command segment (strips env-var prefixes like FOO=bar). */
const leadWord = (segment: string): string => {
	const toks = segment.trim().split(/\s+/);
	let i = 0;
	while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i] ?? "")) i++;
	return (toks[i] ?? "").replace(/^\\/, ""); // unalias e.g. \grep
};

const RULES: Rule[] = [
	{
		category: "read",
		test: (c) => /^(cat|head|tail|less|more|bat)$/.test(leadWord(c)),
		tool: "read",
		reason: "Reading a file via bash cat/head/tail.",
	},
	{
		category: "ls",
		test: (c) => /^(ls|tree|exa|eza)$/.test(leadWord(c)),
		tool: "ls",
		reason: "Listing a directory via bash ls/tree.",
	},
	{
		category: "grep",
		test: (c) => /^(grep|rg|ag|ack)$/.test(leadWord(c)),
		tool: "grep",
		reason: "Searching file contents via bash grep/rg.",
	},
	{
		category: "find",
		test: (c) => /^(find|fd|fdfind)$/.test(leadWord(c)),
		tool: "find",
		reason: "Locating files via bash find/fd.",
	},
	{
		category: "edit",
		test: (c) => /^sed$/.test(leadWord(c)) && /\s-i\b/.test(c),
		tool: "edit",
		reason: "Editing a file in place via bash `sed -i`.",
	},
	{
		category: "ssh",
		test: (c) => /^ssh$/.test(leadWord(c)),
		tool: "ssh_run",
		reason: "Running a remote command via bash ssh.",
	},
	{
		category: "sudo",
		test: (c) => /^sudo$/.test(leadWord(c)),
		tool: "sudo_run",
		reason: "Running a command as root via bash sudo.",
	},
];

/**
 * Pick a rule only when the command is a *simple* single-command invocation
 * standing in for a tool. Skip anything with pipes, redirects, command
 * chaining, or subshells — those are legitimate shell work bash should handle.
 */
export function classify(command: string): Rule | undefined {
	const cmd = command.trim();
	if (!cmd) return undefined;
	// Bail on compound / piped / redirected commands — real shell work.
	if (/[|&;]|\$\(|`|<|>|\n/.test(cmd)) return undefined;
	return RULES.find((r) => r.test(cmd));
}

/**
 * A segment of a compound command, paired with the operator that *follows* it.
 * The trailing operator distinguishes a stand-in (`cat x ||`, `cat x ;`) from a
 * genuine pipe producer (`cat x |`) whose output feeds a downstream consumer.
 */
interface Segment {
	text: string;
	/** Operator immediately after this segment: "|", ";", "&&", "||", "&", or "". */
	followedBy: string;
}

/**
 * Split a command line into segments on shell control operators, recording the
 * operator that follows each segment. Subshells and redirects are NOT split —
 * a segment containing `$(...)`, backticks, or a redirect is treated as opaque
 * shell work and will fail the single-command `classify` check below.
 */
export function splitSegments(command: string): Segment[] {
	const out: Segment[] = [];
	const re = /(\|\||&&|[|;&\n])/g;
	let last = 0;
	for (const m of command.matchAll(re)) {
		out.push({
			text: command.slice(last, m.index),
			followedBy: m[1] ?? "",
		});
		last = m.index + (m[1] ?? "").length;
	}
	out.push({ text: command.slice(last), followedBy: "" });
	return out.filter((s) => s.text.trim().length > 0);
}

/**
 * Classify a possibly-compound command. Returns the FIRST rule matching a
 * segment that is a *pure tool stand-in*: a simple single-command invocation
 * whose output is not piped into a downstream consumer.
 *
 * - `cat x || ls y`      → nudge (read) — chaining-dodge, not real shell work.
 * - `ls; pwd`            → nudge (ls)  — sequential stand-in alongside other cmd.
 * - `cat x | jq .`       → undefined   — `cat` feeds a pipe; legitimate.
 * - `grep x y > out`     → undefined   — redirect; opaque per-segment.
 * - `git log | cat`      → undefined   — no segment is a leading stand-in.
 */
export function classifyCompound(command: string): Rule | undefined {
	const cmd = command.trim();
	if (!cmd) return undefined;

	// Fast path: a truly simple command (no operators/subshell/redirect).
	const simple = classify(cmd);
	if (simple) return simple;

	// Otherwise inspect each segment of the compound command. A segment is a
	// legitimate part of a pipeline — not a stand-in — when it either feeds a
	// pipe (producer) or is fed by one (consumer). Only segments outside any
	// pipe relationship are candidate tool stand-ins.
	const segs = splitSegments(cmd);
	for (let i = 0; i < segs.length; i++) {
		const seg = at(segs, i);
		if (seg.followedBy === "|") continue; // producer feeding a pipe
		if (i > 0 && at(segs, i - 1).followedBy === "|") continue; // consumer of a pipe
		// Per-segment we reuse the strict single-command classifier, which itself
		// rejects redirects/subshells/nested operators inside the segment.
		const rule = classify(seg.text);
		if (rule) return rule;
	}
	return undefined;
}

/**
 * Build the one-line guidance for a nudge. When the target tool is active, point
 * straight at it. When it's gated out, point at toolbox to enable it — never
 * imply a gated tool is callable now. Pure + exported for unit testing.
 */
export function nudgeReason(baseReason: string, tool: string, toolActive: boolean): string {
	const how = toolActive
		? `Use \`${tool}\` instead — it's in the function definitions, call it directly.`
		: `\`${tool}\` is prompt-hidden — enable it via toolbox(action:"enable", name:"${tool}") to make it known, then call it; bash is fine until then. (All tools are always callable via function definitions.)`;
	return `${baseReason} ${how} (Fires once per category; bash stays available for pipes & compound commands.)`;
}

export default function registerToolsNudge(pi: ExtensionAPI): void {
	// Categories already nudged this session — warn once, then stay silent.
	const nudged = new Set<Category>();

	/** Is `name` in the host's current active set (i.e. callable right now)? */
	function isActive(name: string): boolean {
		try {
			// getActiveTools() returns string[] (tool NAMES), not ToolInfo[].
			return (pi.getActiveTools() ?? []).includes(name);
		} catch {
			// If we can't tell, assume active so we don't suppress a valid nudge.
			return true;
		}
	}

	/** Is `name` registered at all (active or gated)? ssh_run is opt-in — absent when pix-ssh isn't installed. */
	function isRegistered(name: string): boolean {
		try {
			return (pi.getAllTools?.() ?? []).some((t) => t.name === name);
		} catch {
			return true;
		}
	}

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		const command = event.input.command;
		if (typeof command !== "string") return;

		const rule = classifyCompound(command);
		if (!rule) return;
		// ssh_run / sudo_run are standalone opt-in tools — without them, the bash
		// form is the only path, so don't nudge toward a tool that isn't there.
		if ((rule.tool === "ssh_run" || rule.tool === "sudo_run") && !isRegistered(rule.tool)) return;
		if (nudged.has(rule.category)) return; // already taught — allow.

		nudged.add(rule.category);

		// One short, targeted line: name only the tool that maps to THIS command,
		// and route through toolbox when it's gated rather than implying it's
		// callable now. No full-inventory dump — that's what confused the model.
		const reason = nudgeReason(rule.reason, rule.tool, isActive(rule.tool));

		// Surface the guidance as a YELLOW warning notification — non-blocking.
		// Blocking the call rendered red AND forced a failed retry through the
		// proper tool, wasting a turn. This nudge is corrective guidance, not a
		// failure: let the command proceed and just teach for next time.
		ctx.ui.notify(reason, "warning");
	});
}
