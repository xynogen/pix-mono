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

import type {
	ExtensionAPI,
	ToolResultEvent,
	ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { currentPlatform, type HostOs } from "@xynogen/pix-runtime/platform";
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
type Category =
	| "read"
	| "ls"
	| "grep"
	| "find"
	| "edit"
	| "poll"
	| "heredoc"
	| "python"
	| "powershell";

interface Rule {
	category: Category;
	/** Match the *leading* command word(s). */
	test: (cmd: string) => boolean;
	tool: string;
	reason: string;
	/** The tool options that replace the shell idiom, so the model knows what to pass. */
	hint: string;
	/** Closing note; defaults to the "bash for pipelines" reminder. */
	note?: string;
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
	{
		category: "python",
		// Only a standalone snippet: `cmd | python3 -c …` reads a pipe python_run cannot feed.
		test: (c) => /^\s*(cd\s+\S+\s*&&\s*)?python3?\s+(-c\b|(-\s*)?<<)/.test(c),
		tool: "python_run",
		reason: "Running an inline Python snippet via bash.",
		hint: "intent + code; tabs/indent repaired, no shell quoting",
	},
];

/**
 * Windows only: any bash call that no other rule caught steers once toward the
 * native `powershell` tool. Bash stays enabled; this only states the preference.
 */
const POWERSHELL_RULE: Rule = {
	category: "powershell",
	test: () => true,
	tool: "powershell",
	reason: "This host is Windows.",
	hint: "native Windows paths, cmdlets and env",
	note: "Keep bash only for POSIX-specific scripts.",
};

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

	// Mask operators inside quotes so `rg "a|b" src` is not mistaken for a pipeline.
	const masked = command.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, (q) =>
		q.replace(/[|&;<>`$\n]/g, "_"),
	);
	const cmd = masked.trim().replace(TRAILING_TRIM, "");
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
 * Names of the tools registered this session, or undefined when the host cannot
 * say. Every nudge checks names against this set so it never steers the model
 * toward a tool that is not installed (a call to it would only fail).
 */
export function registeredToolNames(
	pi: Pick<ExtensionAPI, "getAllTools">,
): Set<string> | undefined {
	try {
		return new Set(pi.getAllTools().map((t) => t.name));
	} catch {
		return undefined;
	}
}

/** Backticked tool ids in a hint, e.g. "or `edit` for changes" → ["edit"]. */
const hintTools = (hint: string) => [...hint.matchAll(/`([a-z_]+)`/g)].map((m) => m[1] ?? "");

/**
 * One-line guidance for a nudge. Active tool → call it directly. Deferred tool
 * → the handler has just loaded it, so say so and point at it. `hint` names the
 * options that replace the shell idiom. Pure + exported for unit testing.
 */
export function nudgeReason(
	baseReason: string,
	tool: string,
	toolActive: boolean,
	hint?: string,
	note = "Use bash for genuine shell pipelines, not chained tool replacements.",
): string {
	const opts = hint ? ` (${hint})` : "";
	const how = toolActive
		? `Use \`${tool}\`${opts} instead.`
		: `Loaded \`${tool}\` for you; call it directly next time${opts}.`;
	return `${baseReason} ${how} (${note})`;
}

/**
 * The nudge for `rule`, or undefined when it would name a tool the session lacks:
 * the target, `tool_search` for a deferred target, or a tool in the hint (then the
 * hint is dropped, not the nudge). Unknown registry → no nudge. `load` is true when
 * the target is deferred, so the caller must activate it before the text is true.
 */
export function nudgeFor(
	rule: Pick<Rule, "reason" | "tool" | "hint" | "note">,
	registered: Set<string> | undefined,
	active: string[] | undefined,
): { text: string; load: boolean } | undefined {
	if (!registered?.has(rule.tool)) return undefined;
	// No active list → treat as active: the tool is registered, so naming it is safe.
	const isActive = !active || active.includes(rule.tool);
	// Deferred tools load through the active set, which tool_search also owns.
	if (!isActive && !registered.has("tool_search")) return undefined;
	const hint = hintTools(rule.hint).every((t) => registered.has(t)) ? rule.hint : undefined;
	return { text: nudgeReason(rule.reason, rule.tool, isActive, hint, rule.note), load: !isActive };
}

/** After the first nudge of a category, repeat it on every Nth matching bash call. */
// ponytail: fixed cadence; make it a pix.json knob if a model needs more or fewer reminders.
const NUDGE_EVERY = 5;

export default function registerToolsNudge(
	pi: ExtensionAPI,
	os: HostOs = currentPlatform().os,
): void {
	// Shell use per category. Nudge on the 1st and then every NUDGE_EVERY-th use: one
	// warning per session was ignored (31% of bash calls in a long session still had a
	// native tool), and a nudge on every call would be noise.
	const seen = new Map<Category, number>();
	const due = (c: Category): boolean => {
		const n = (seen.get(c) ?? 0) + 1;
		seen.set(c, n);
		return n === 1 || n % NUDGE_EVERY === 0;
	};

	pi.on("tool_result", (event) => {
		if (event.toolName === "read") return wholeRead(event);
		if (event.toolName !== "bash") return;
		const command = event.input?.command;
		if (typeof command !== "string") return;

		const matched = classifyCompound(command);
		const rule =
			matched && due(matched.category)
				? matched
				: !matched && os === "win32" && due("powershell")
					? POWERSHELL_RULE
					: undefined;
		if (!rule) return;
		let active: string[] | undefined;
		try {
			// getActiveTools() returns string[] (tool NAMES), not ToolInfo[].
			active = pi.getActiveTools() ?? undefined;
		} catch {
			active = undefined;
		}
		const nudge = nudgeFor(rule, registeredToolNames(pi), active);
		if (!nudge) return;
		// Load the deferred target the same way tool_search does, so the model can call
		// it next turn without a discovery round-trip. The card below makes it visible.
		if (nudge.load && active) {
			try {
				pi.setActiveTools([...active, rule.tool]);
			} catch {
				return;
			}
		}

		// Card body = the exact text appended to the model's tool result.
		const text = `[pix-nudge] ${nudge.text}`;
		pi.appendEntry<NudgeCard>(NUDGE_ENTRY, {
			kind: "tool",
			summary: `bash ${rule.category} → ${rule.tool}${nudge.load ? " (loaded)" : ""}`,
			body: text,
		});
		return {
			content: [...(event.content ?? []), { type: "text" as const, text }],
			structuredContent: event.structuredContent,
		};
	});

	// A whole-file read of a large source file: the model usually needs one symbol or the
	// shape, so point at the AST tools once. Nudged only when the target tool exists.
	let outlined = false;
	const wholeRead = (event: ToolResultEvent): ToolResultEventResult | undefined => {
		if (outlined || event.isError || event.input.offset !== undefined) return;
		const path = event.input.path;
		if (typeof path !== "string" || !OUTLINE_FILE.test(path)) return;
		const text = event.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
		if (text.split("\n").length < OUTLINE_MIN_LINES) return;
		let active: string[] | undefined;
		try {
			active = pi.getActiveTools() ?? undefined;
		} catch {
			active = undefined;
		}
		const nudge = nudgeFor(OUTLINE_RULE, registeredToolNames(pi), active);
		if (!nudge) return;
		outlined = true;
		if (nudge.load && active) {
			try {
				pi.setActiveTools([...active, OUTLINE_RULE.tool]);
			} catch {
				return;
			}
		}
		const note = `[pix-nudge] ${nudge.text}`;
		pi.appendEntry<NudgeCard>(NUDGE_ENTRY, {
			kind: "tool",
			summary: `read whole file → ${OUTLINE_RULE.tool}${nudge.load ? " (loaded)" : ""}`,
			body: note,
		});
		return { content: [...event.content, { type: "text" as const, text: note }] };
	};
}

/** Source files the AST tools understand. Markdown, JSON and logs stay plain reads. */
const OUTLINE_FILE =
	/\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php|cs|c|cc|cpp|h|hpp|swift|scala|lua)$/;
// ponytail: one fixed size. 300 lines is where a whole read costs more than outline + one symbol.
const OUTLINE_MIN_LINES = 300;
const OUTLINE_RULE: Pick<Rule, "reason" | "tool" | "hint" | "note"> = {
	reason: "Read a large source file whole.",
	tool: "ast_outline",
	hint: "then `ast_read_symbol` for one function",
	note: "Use read with offset/limit when you already know the lines.",
};
