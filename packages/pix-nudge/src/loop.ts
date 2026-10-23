/**
 * loop.ts — flag a doom loop: the same tool call, or the same short cycle of
 * calls (A,B,A,B…), returning the same results several times in a row
 * (Gemini CLI / OpenCode failure mode).
 *
 * The fingerprint covers tool name, arguments AND result text, so a repeated
 * `bun run test` after an edit (new output) is not a loop. Gemini CLI keys on
 * arguments only and needs 5 repeats; including the result lets us fire at 3
 * without flagging legitimate polling. Cycles up to MAX_CYCLE calls long are
 * checked, shortest first. It appends one visible line to the result that
 * completes the pattern, mirrors it as a warning notify, and never blocks: the
 * user stays in charge of stopping the run.
 */

import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const LOOP_THRESHOLD = 3;
export const MAX_CYCLE = 5;

export function loopReason(tools: string[], repeats: number): string {
	const what =
		tools.length === 1
			? `Same \`${tools[0]}\` call`
			: `Same ${tools.length}-call cycle (${tools.map((t) => `\`${t}\``).join(" → ")})`;
	return `${what} returned the same result ${repeats} times in a row. Repeating it will not change the outcome: change the arguments, try another approach, or ask the user.`;
}

/**
 * Tracks recent call fingerprints. Returns the cycle's tool names once, when a
 * cycle of 1..MAX_CYCLE calls first repeats `threshold` times; stays quiet
 * until the pattern breaks. Pure, for unit tests.
 */
export function createLoopTracker(threshold = LOOP_THRESHOLD) {
	const history: Array<{ fp: string; tool: string }> = [];
	let flagged = false;
	return (tool: string, input: unknown, content: unknown): string[] | undefined => {
		const fp = createHash("sha1")
			.update(JSON.stringify([tool, input, content]) ?? "")
			.digest("hex");
		history.push({ fp, tool });
		if (history.length > MAX_CYCLE * threshold) history.shift();
		const n = history.length;
		let cycle: number | undefined;
		for (let k = 1; k <= MAX_CYCLE && !cycle; k++) {
			if (n < k * threshold) break;
			let repeats = true;
			for (let i = n - k * threshold; i < n - k && repeats; i++)
				repeats = history[i]?.fp === history[i + k]?.fp;
			if (repeats) cycle = k;
		}
		if (!cycle) {
			flagged = false;
			return undefined;
		}
		if (flagged) return undefined;
		flagged = true;
		return history.slice(n - cycle).map((h) => h.tool);
	};
}

export default function registerLoopNudge(pi: ExtensionAPI): void {
	const track = createLoopTracker();
	pi.on("tool_result", (event, ctx) => {
		const tools = track(event.toolName, event.input, event.content);
		if (!tools) return;
		const reason = loopReason(tools, LOOP_THRESHOLD);
		ctx.ui.notify(reason, "warning");
		return {
			content: [...(event.content ?? []), { type: "text" as const, text: `[pix-nudge] ${reason}` }],
			structuredContent: event.structuredContent,
		};
	});
}
