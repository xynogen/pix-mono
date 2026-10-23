/**
 * Pure metrics over a `pi --mode json` event stream (docs/json.md).
 * Kept free of I/O so it unit-tests against a hand-built stream.
 */

export interface RunMetrics {
	model: string;
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	toolCalls: number;
	byTool: Record<string, number>;
	toolErrors: number;
	editFailed: number;
	editStale: number;
	/** Text of the last assistant message — what answer-style tasks check. */
	finalText: string;
	/** The stream ended inside a tool call whose arguments degenerated into whitespace. */
	runaway: boolean;
	/** Assistant turns that ended with a provider/transport error (stopReason "error"). */
	providerErrors: number;
	/** Compactions that finished (Pi summarized the context). */
	compactions: number;
}

/** Trailing whitespace in an unfinished tool call that counts as a runaway generation. */
const RUNAWAY_WHITESPACE = 1000;

interface Usage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

interface Block {
	type: string;
	text?: string;
}

/** Split strictly on LF (docs/json.md: U+2028/U+2029 are not record boundaries). */
export function parseJsonl(text: string): unknown[] {
	const out: unknown[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.replace(/\r$/, "").trim();
		if (!line.startsWith("{")) continue;
		try {
			out.push(JSON.parse(line));
		} catch {
			// A non-JSON line on stdout is a host bug, not a metric; skip it.
		}
	}
	return out;
}

const textOf = (content: unknown): string =>
	Array.isArray(content)
		? (content as Block[])
				.filter((b) => b?.type === "text")
				.map((b) => b.text ?? "")
				.join("")
		: typeof content === "string"
			? content
			: "";

export function collectMetrics(events: unknown[]): RunMetrics {
	const m: RunMetrics = {
		model: "",
		turns: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		toolCalls: 0,
		byTool: {},
		toolErrors: 0,
		editFailed: 0,
		editStale: 0,
		finalText: "",
		runaway: false,
		providerErrors: 0,
		compactions: 0,
	};
	let openArgs: string | undefined;
	for (const e of events as Array<Record<string, any>>) {
		const ev = e?.type === "message_update" ? e.assistantMessageEvent : undefined;
		if (ev?.type === "toolcall_start") openArgs = "";
		else if (ev?.type === "toolcall_delta" && openArgs !== undefined)
			openArgs = (openArgs + String(ev.delta ?? "")).slice(-RUNAWAY_WHITESPACE);
		else if (ev?.type === "toolcall_end") openArgs = undefined;
		if (e?.type === "compaction_end" && e.result) m.compactions++;
		if (e?.type === "message_end" && e.message?.role === "assistant") {
			openArgs = undefined;
			if (e.message.stopReason === "error") m.providerErrors++;
			const msg = e.message;
			const u: Usage = msg.usage ?? {};
			m.turns++;
			m.input += u.input ?? 0;
			m.output += u.output ?? 0;
			m.cacheRead += u.cacheRead ?? 0;
			m.cacheWrite += u.cacheWrite ?? 0;
			m.cost += u.cost?.total ?? 0;
			if (msg.model) m.model = msg.provider ? `${msg.provider}/${msg.model}` : msg.model;
			const text = textOf(msg.content).trim();
			if (text) m.finalText = text;
		} else if (e?.type === "tool_execution_end") {
			const name = String(e.toolName ?? "?");
			m.toolCalls++;
			m.byTool[name] = (m.byTool[name] ?? 0) + 1;
			if (!e.isError) continue;
			m.toolErrors++;
			if (name !== "edit") continue;
			m.editFailed++;
			if (/stale anchor/i.test(textOf(e.result?.content))) m.editStale++;
		}
	}
	m.runaway = openArgs?.length === RUNAWAY_WHITESPACE && !openArgs.trim();
	return m;
}

/** Share of prompt tokens served from cache (0 when nothing was sent). */
export function cacheRatio(m: Pick<RunMetrics, "input" | "cacheRead">): number {
	const prompt = m.input + m.cacheRead;
	return prompt ? m.cacheRead / prompt : 0;
}
