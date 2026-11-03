/**
 * Behavior stats for one Pi session file (`~/.pi/agent/sessions/.../*.jsonl`): the habits the
 * context features target, which `scripts/eval` cannot see in real use. Compare a session
 * before and after a change.
 *
 *   bun scripts/session-stats.ts <session.jsonl> [--json]
 *
 * Re-read: the same path read again with no write/edit to it in between. Masked: tool output
 * replaced by a pix compaction stub. Shell-for-tool: bash calls the pix-nudge would flag.
 */

import { readFileSync } from "node:fs";
import { classifyCompound } from "../packages/pix-nudge/src/tools.ts";

export interface SessionStats {
	assistantTurns: number;
	toolCalls: number;
	byTool: Record<string, number>;
	input: number;
	output: number;
	cacheRead: number;
	reads: number;
	reReads: number;
	topReReads: Array<[string, number]>;
	masked: { output: number; staleRead: number; chars: number };
	bash: number;
	shellForTool: number;
	nudges: number;
	toolSearch: { calls: number; loaded: number; mcpLoaded: number };
	graph: Record<string, number>;
}

type Row = Record<string, any>;

const textOf = (content: unknown): string =>
	Array.isArray(content)
		? content.map((c: Row) => (c?.type === "text" ? String(c.text ?? "") : "")).join("")
		: "";

export function sessionStats(rows: Row[]): SessionStats {
	const s: SessionStats = {
		assistantTurns: 0,
		toolCalls: 0,
		byTool: {},
		input: 0,
		output: 0,
		cacheRead: 0,
		reads: 0,
		reReads: 0,
		topReReads: [],
		masked: { output: 0, staleRead: 0, chars: 0 },
		bash: 0,
		shellForTool: 0,
		nudges: 0,
		toolSearch: { calls: 0, loaded: 0, mcpLoaded: 0 },
		graph: {},
	};
	const resultChars = new Map<string, number>();
	const seen = new Map<string, number>();
	const reReadBy = new Map<string, number>();

	for (const r of rows) {
		const m = r.message as Row | undefined;
		if (r.type === "context_edit" && r.replacement) {
			const stub = textOf(r.replacement.content);
			if (stub.startsWith("[pix compaction: output masked")) s.masked.output++;
			else if (stub.startsWith("[pix compaction: stale read masked")) s.masked.staleRead++;
			else continue;
			s.masked.chars += resultChars.get(r.targetId) ?? 0;
			continue;
		}
		if (!m) continue;
		if (m.role === "assistant") {
			s.assistantTurns++;
			s.input += m.usage?.input ?? 0;
			s.output += m.usage?.output ?? 0;
			s.cacheRead += m.usage?.cacheRead ?? 0;
			for (const c of m.content ?? []) {
				if (c.type !== "toolCall") continue;
				const name = String(c.name);
				const args = (c.arguments ?? {}) as Row;
				s.toolCalls++;
				s.byTool[name] = (s.byTool[name] ?? 0) + 1;
				if (name === "read") {
					for (const p of args.paths ?? [args.path]) {
						if (typeof p !== "string") continue;
						s.reads++;
						const n = (seen.get(p) ?? 0) + 1;
						seen.set(p, n);
						if (n > 1) {
							s.reReads++;
							reReadBy.set(p, n - 1);
						}
					}
				} else if (name === "edit" || name === "write") {
					if (typeof args.path === "string") seen.delete(args.path);
				} else if (name === "bash") {
					s.bash++;
					if (typeof args.command === "string" && classifyCompound(args.command)) s.shellForTool++;
				} else if (name === "tool_search") {
					s.toolSearch.calls++;
				} else if (name === "graph") {
					const action = String(args.action ?? "?");
					s.graph[action] = (s.graph[action] ?? 0) + 1;
				}
			}
		} else if (m.role === "toolResult") {
			const text = textOf(m.content);
			resultChars.set(r.id, text.length);
			if (text.includes("[pix-nudge]")) s.nudges++;
			if (m.toolName === "tool_search") {
				const loaded: string[] = m.details?.loaded ?? [];
				s.toolSearch.loaded += loaded.length;
				s.toolSearch.mcpLoaded += loaded.filter((n) => n.startsWith("mcp__")).length;
			}
		}
	}
	s.topReReads = [...reReadBy].sort((a, b) => b[1] - a[1]).slice(0, 5);
	return s;
}

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "-");

export function formatStats(s: SessionStats): string {
	const tools = Object.entries(s.byTool)
		.sort((a, b) => b[1] - a[1])
		.map(([n, c]) => `${n} ${c}`)
		.join(", ");
	return [
		`turns ${s.assistantTurns} · tool calls ${s.toolCalls} · input ${s.input} · output ${s.output} · cache read ${s.cacheRead}`,
		`tools: ${tools}`,
		`reads ${s.reads} · re-reads without an edit between ${s.reReads} (${pct(s.reReads, s.reads)})${s.topReReads.length ? `: ${s.topReReads.map(([p, n]) => `${p} +${n}`).join(", ")}` : ""}`,
		`masked: ${s.masked.output} output + ${s.masked.staleRead} stale read, ${s.masked.chars} chars`,
		`bash ${s.bash} · shell for a native tool ${s.shellForTool} (${pct(s.shellForTool, s.bash)}) · nudges ${s.nudges}`,
		`tool_search ${s.toolSearch.calls} calls · loaded ${s.toolSearch.loaded} (MCP ${s.toolSearch.mcpLoaded}, ${pct(s.toolSearch.mcpLoaded, s.toolSearch.loaded)})`,
		`graph: ${Object.entries(s.graph).map(([a, n]) => `${a} ${n}`).join(", ") || "none"}`,
	].join("\n");
}

if (import.meta.main) {
	const [file, flag] = process.argv.slice(2);
	if (!file) {
		console.error("usage: bun scripts/session-stats.ts <session.jsonl> [--json]");
		process.exit(2);
	}
	const rows = readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l.startsWith("{"))
		.map((l) => JSON.parse(l) as Row);
	const s = sessionStats(rows);
	console.log(flag === "--json" ? JSON.stringify(s, null, 2) : formatStats(s));
}
