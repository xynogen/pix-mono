/**
 * tools-nudge.ts — nudge the model toward dedicated tools over raw bash
 *
 * Hooks `tool_result` for the built-in `bash` tool. When a bash command merely
 * reimplements a first-class tool (read/ls/grep/find/edit), it appends ONE
 * short line to that bash result — the only channel the model reads
 * — and shows the user a collapsed nudge card (card.ts, no model context).
 * Once per category per session; the command always runs (blocking forced a
 * wasted retry turn). Bash stays available for pipes and compound work.
 *
 * Deferred tools (pix-core keeps only core tools in the prompt) are not active
 * until loaded, so the line then points at `tool_search` instead of implying
 * the tool is callable now. Names only the one matching tool — no inventory.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NUDGE_ENTRY, type NudgeCard } from "./card.ts";

/** In-bounds array access that satisfies noUncheckedIndexedAccess without casting. */
function at<T>(arr: T[], i: number): T {
	return arr[i] as T;
}

/**
 * Categories that map a raw shell command to a dedicated Pi tool.
 *
 * Steering only — these teach a leaner tool without blocking. Privileged auth
 * stand-ins (bash `sudo`/`ssh`) are NOT here: they are *guarded* (hard block +
 * redirect) by pix-gate, a separate concern. Guard = stop; nudge = steer.
 */
type Category = "read" | "ls" | "grep" | "find" | "edit" | "poll" | "heredoc";

interface Rule {
	category: Category;
	/** Match the *leading* command word(s). */
	test: (cmd: string) => boolean;
	tool: string;
	reason: string;
	/** The tool options that replace the shell idiom, so the model knows what to pass. */
	hint: string;
}

/**
 * First bare word of a command segment. Strips env-var prefixes (FOO=bar) and
 * an `rtk` wrapper: pix-optimizer rewrites `grep x` to `rtk grep x` in place
 * before tool_result fires, which otherwise hides every stand-in.
 */
const leadWord = (segment: string): string => {
	const toks = segment.trim().split(/\s+/);
	let i = 0;
	while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i] ?? "")) i++;
	if (toks[i] === "rtk") i++;
	return (toks[i] ?? "").replace(/^\\/, ""); // unalias e.g. \grep
};

const RULES: Rule[] = [
	{
		category: "read",
		// `sed -n '10,40p' f` is a line-range read, not an edit.
		test: (c) =>
			/^(cat|head|tail|less|more|bat)$/.test(leadWord(c)) ||
			(leadWord(c) === "sed" && /\s-n\b/.test(c) && /\d+(,\d+)?p\b/.test(c) && !/\s-i\b/.test(c)),
		tool: "read",
		reason: "Reading a file via bash cat/head/tail/sed -n.",
		hint: "offset/limit pick lines",
	},
	{
		category: "ls",
		test: (c) => /^(ls|tree|exa|eza)$/.test(leadWord(c)),
		tool: "ls",
		reason: "Listing a directory via bash ls/tree.",
		hint: "limit caps entries",
	},
	{
		category: "grep",
		test: (c) => /^(grep|rg|ag|ack)$/.test(leadWord(c)),
		tool: "grep",
		reason: "Searching file contents via bash grep/rg.",
		hint: "glob, context, limit",
	},
	{
		category: "find",
		test: (c) => /^(find|fd|fdfind)$/.test(leadWord(c)),
		tool: "find",
		reason: "Locating files via bash find/fd.",
		hint: "glob pattern, limit",
	},
	{
		category: "edit",
		test: (c) => leadWord(c) === "sed" && /\s-i\b/.test(c),
		tool: "edit",
		reason: "Editing a file in place via bash `sed -i`.",
		hint: "exact replacements with a reviewable diff",
	},
];

/**
 * Trailing `| head`/`| tail` stages only trim output, which the tools' limit and
 * offset options already do. Strip them so `grep x | head` counts as a stand-in.
 * Session data: stand-in | head/tail was the largest missed group (~220 calls).
 */
const TRAILING_TRIM = /(\s*\|\s*(head|tail)(\s+-n)?(\s+-?\d+)?)+\s*$/;

/** Drop heredoc bodies and quoted strings so `&`, `sleep`, `>` inside them never match. */
function shellSkeleton(command: string): string {
	return command
		.replace(/<<-?\s*['"]?(\w+)['"]?([^\n]*)\n[\s\S]*?\n\s*\1\s*(?=\n|$)/g, "<<H$2")
		.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "''")
		.replace(/\\./g, "") // escaped chars, e.g. `\&` in a URL
		.replace(/(^|\s)#[^\n]*/g, "$1"); // comments
}

const isScratchPath = (p: string) => /^(\/tmp\/|\/var\/tmp\/|\/dev\/|\$\{?TMP|&)/i.test(p);

/** A heredoc whose output lands in a real file (`cat > f <<EOF`, `cat <<EOF > f`, `tee f <<EOF`). */
function heredocToFile(command: string): boolean {
	const head = shellSkeleton(command)
		.split("\n")
		.find((line) => line.includes("<<"));
	if (!head || !/\b(cat|tee)\b/.test(head)) return false;
	const targets = [
		...head.replace(/<<-?\S*/, "").matchAll(/(?:>{1,2}|\btee(?:\s+-a)?)\s*([^\s;&|<>]+)/g),
	].map((m) => m[1] ?? "");
	return targets.some((t) => t && !isScratchPath(t));
}

/** `python - <<EOF` that opens a file for writing outside scratch dirs. */
function scriptWritesFile(command: string): boolean {
	if (!/\bpython3?\s+-\s*<</.test(command)) return false;
	if (/\/tmp\//.test(command)) return false;
	return /open\([^)]*['"][wa]\+?['"]|\.write_(text|bytes)\(/.test(command);
}

/**
 * Whole-command patterns. Unlike RULES these look across the full command,
 * because the idiom (heredoc body, trailing `&`) only shows up in compound
 * commands. Replay of 17,757 session commands: 108 backgrounded processes
 * (`&`/nohup) → `proc`; 230 heredoc/script writes to real files → `write`.
 * `sleep` alone is NOT a rule: most hits were `sleep 2` after `pkill` or
 * `sleep N && gh run list` (whose right fix is `gh run watch`, not `proc`).
 */
const WHOLE_RULES: Rule[] = [
	{
		category: "poll",
		test: (c) => {
			const s = shellSkeleton(c);
			// A lone `&` (background), not `&&`, `2>&1`, `&>`, or `|&`.
			return /\b(nohup|setsid|disown)\b/.test(s) || /(?<![&>|<])&(?![&>])/.test(s);
		},
		tool: "proc",
		reason: "Backgrounding a process via bash &/nohup.",
		hint: "start returns a handle, logs reads output, stop ends it; no sleep polling",
	},
	{
		category: "heredoc",
		test: (c) => heredocToFile(c) || scriptWritesFile(c),
		tool: "write",
		reason: "Writing a file via a bash heredoc/script.",
		hint: "or `edit` for changes, so the user sees what changed",
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
	const whole = WHOLE_RULES.find((r) => r.test(command));
	if (whole) return whole;

	const cmd = command.trim().replace(TRAILING_TRIM, "");
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
 * One-line guidance for a nudge. Active tool → call it directly. Deferred tool
 * → load it with `tool_search` first. `hint` names the options that replace the
 * shell idiom. Pure + exported for unit testing.
 */
export function nudgeReason(
	baseReason: string,
	tool: string,
	toolActive: boolean,
	hint?: string,
): string {
	const opts = hint ? ` (${hint})` : "";
	const how = toolActive
		? `Use \`${tool}\`${opts} instead.`
		: `Load \`${tool}\` with tool_search, then call it${opts}.`;
	return `${baseReason} ${how} (Once per category; bash stays fine for real pipelines and compound commands.)`;
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

	/** Skip nudges toward a tool this session does not have at all (e.g. no pix-proc). */
	function isRegistered(name: string): boolean {
		try {
			return pi.getAllTools().some((t) => t.name === name);
		} catch {
			return true;
		}
	}

	pi.on("tool_result", (event) => {
		if (event.toolName !== "bash") return;
		const command = event.input?.command;
		if (typeof command !== "string") return;

		const rule = classifyCompound(command);
		if (!rule || nudged.has(rule.category) || !isRegistered(rule.tool)) return;
		nudged.add(rule.category);

		const reason = nudgeReason(rule.reason, rule.tool, isActive(rule.tool), rule.hint);
		pi.appendEntry<NudgeCard>(NUDGE_ENTRY, {
			kind: "tool",
			summary: `bash ${rule.category} → ${rule.tool}`,
			body: reason,
		});
		return {
			content: [...(event.content ?? []), { type: "text" as const, text: `[pix-nudge] ${reason}` }],
			structuredContent: event.structuredContent,
		};
	});
}
