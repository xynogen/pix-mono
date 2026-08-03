/**
 * pix-core compaction — replaces pi's built-in compaction so the prompt and
 * trigger are ours to experiment with.
 *
 * Two independent levers (see AGENTS.md product constraints):
 *
 *   1. Summary prompt — ALWAYS ours. `session_before_compact` fires for every
 *      compaction (manual, threshold, overflow); we generate the summary with
 *      the CURRENT conversation model (no silent routing) using SUMMARY_PROMPT
 *      below. Edit the prompt/format to experiment.
 *
 *   2. Trigger — ours when `compaction.triggerPercent > 0`. After each settled
 *      turn we read live context usage and call ctx.compact() once usage
 *      reaches that percent of the active model's context window. Since it
 *      scales with the model, it fires before pi's reserveTokens threshold in
 *      practice — effectively replacing pi's trigger while pi's own threshold
 *      stays as an overflow safety net. `triggerPercent === 0` disables it: we
 *      keep our prompt but let pi decide when to compact.
 *
 * After a self-triggered compaction we send a short user message (RESUME_NUDGE)
 * so the agent picks its task back up on its own. It's a normal user message —
 * visible in the transcript, no hidden automation.
 *
 * Everything stays visible: each self-trigger, resume, and summary run emit a
 * notify line with reason, model, and token counts.
 */

import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { config } from "@xynogen/pix-runtime/config";
import { compactionSection } from "@xynogen/pix-runtime/sections";

// ── Editable summary prompt ──────────────────────────────────────────────────
// Keep-recent-turns strategy: summarize the OLD span into high-signal notes;
// pi keeps recent turns verbatim (via firstKeptEntryId). This matches current
// context-engineering guidance — recency is highest-signal, and "context rot"
// makes full-history replacement risky. Tune freely.
const SUMMARY_PROMPT = (previousSummary: string | undefined, conversation: string): string => {
	const prior = previousSummary
		? `\n\nPrevious summary (fold in, do not repeat verbatim):\n${previousSummary}`
		: "";
	return `You are summarizing the OLDER part of a coding session. Recent turns are kept verbatim after your summary, so capture only what those recent turns would otherwise lose.${prior}

Produce compact, high-signal markdown with these sections (omit a section if empty):

## Goal
## Constraints & Preferences
## Progress (Done / In Progress / Blocked)
## Key Decisions (with rationale)
## Next Steps
## Critical Context (facts, paths, values needed to continue)

Be terse. Prefer names, paths, numbers over prose. No filler.

<conversation>
${conversation}
</conversation>`;
};

const MAX_SUMMARY_TOKENS = 8192;

// Sent as a user message after a self-triggered compaction so the agent picks
// its task back up on its own. Kept short — the freshly written summary already
// carries the goal, progress, and next steps. Edit to taste.
const RESUME_NUDGE =
	"Context was just compacted. Review the summary above and continue the task from where you left off, following its Next Steps. If the task is already complete, say so.";

export default function registerCompaction(pi: ExtensionAPI): void {
	// ── Lever 1: always supply our own summary ────────────────────────────────
	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, reason, signal } = event;
		const model = ctx.model;
		if (!model) return; // no model → fall back to pi's built-in compaction

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			ctx.ui.notify(`Compaction: auth failed (${auth.error}); using built-in`, "warning");
			return;
		}

		const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
		const conversation = serializeConversation(convertToLlm(messages));
		ctx.ui.notify(
			`Compaction (${reason}): summarizing ${messages.length} msgs / ${preparation.tokensBefore.toLocaleString()} tok with ${model.id}`,
			"info",
		);

		try {
			const response = await complete(
				model,
				{
					messages: [
						{
							role: "user" as const,
							content: [
								{
									type: "text" as const,
									text: SUMMARY_PROMPT(preparation.previousSummary, conversation),
								},
							],
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					env: auth.env,
					maxTokens: MAX_SUMMARY_TOKENS,
					signal,
					cacheRetention: "none",
				},
			);

			const summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n")
				.trim();

			if (!summary) {
				if (!signal.aborted) ctx.ui.notify("Compaction: empty summary; using built-in", "warning");
				return;
			}

			return {
				compaction: {
					summary,
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					usage: response.usage,
				},
			};
		} catch (error) {
			if (signal.aborted) return;
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Compaction failed (${message}); using built-in`, "error");
			return;
		}
	});

	// ── Lever 2: our own trigger, driven by live context usage ────────────────
	let compacting = false;
	pi.on("agent_settled", (_event, ctx) => {
		if (compacting) return;
		const { triggerPercent } = config(compactionSection);
		if (triggerPercent <= 0) return;

		const usage = ctx.getContextUsage?.();
		const percent = usage?.percent;
		if (percent == null || percent < triggerPercent) return;

		compacting = true;
		ctx.ui.notify(
			`Compaction: ${Math.round(percent)}% ctx ≥ ${triggerPercent}% threshold — compacting`,
			"info",
		);
		ctx.compact({
			onComplete: () => {
				compacting = false;
				// Nudge the agent to pick its task back up. Visible as a normal
				// user message in the transcript (no hidden automation).
				ctx.ui.notify("Compaction: resuming task", "info");
				pi.sendUserMessage(RESUME_NUDGE);
			},
			onError: (err) => {
				compacting = false;
				ctx.ui.notify(`Compaction trigger failed: ${err.message}`, "error");
			},
		});
	});
}
