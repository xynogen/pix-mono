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
 *      turn we read live context usage and call ctx.compact() once token usage
 *      reaches the larger of that percentage of the active model's context
 *      window and `compaction.minimumTokens`. This prevents low percentages on
 *      smaller models from compacting too early. Pi's own threshold stays as an
 *      overflow safety net. `triggerPercent === 0` disables our trigger: we
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

export function compactionThresholdTokens(
	contextWindow: number,
	triggerPercent: number,
	minimumTokens: number,
): number {
	return Math.max(minimumTokens, Math.ceil((contextWindow * triggerPercent) / 100));
}

/**
 * Decide what to do after a self-triggered compaction completes. Pure so the
 * three branches (the tricky part) are unit-testable without a Pi session.
 *
 * - "loop": compaction landed still at/above threshold — latch the auto-trigger
 *   off so the resume turn doesn't re-fire agent_settled forever.
 * - "skip": the user is already driving (a prompt is in flight or queued).
 *   Injecting the resume nudge would collide with that prompt (the reported
 *   "Agent is already processing a prompt" crash) and, worse, tell the agent to
 *   resume the ORIGINAL task right after the user redirected it.
 * - "resume": agent is idle with room to spare — send the nudge.
 */
export function resumeDecisionAfterCompaction(args: {
	estimatedTokensAfter: number | undefined;
	threshold: number;
	idle: boolean;
	hasPending: boolean;
}): "loop" | "skip" | "resume" {
	if ((args.estimatedTokensAfter ?? 0) >= args.threshold) return "loop";
	if (!args.idle || args.hasPending) return "skip";
	return "resume";
}

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
				.flatMap((c) => (c.type === "text" ? [c.text] : []))
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
	// Latched off if a compaction lands still above threshold (e.g. a large
	// minimumTokens floor on a small model). Without this the resume turn settles,
	// agent_settled re-fires, and we compact again every turn. Reset by /compact or
	// a new session; a session-scoped bool is the smallest fix.
	let triggerDisabled = false;
	pi.on("agent_settled", (_event, ctx) => {
		if (compacting || triggerDisabled) return;
		const { triggerPercent, minimumTokens } = config(compactionSection);
		if (triggerPercent <= 0) return;

		const usage = ctx.getContextUsage?.();
		if (!usage || usage.tokens === null) return;
		const tokens = usage.tokens;
		const threshold = compactionThresholdTokens(usage.contextWindow, triggerPercent, minimumTokens);
		if (tokens < threshold) return;

		compacting = true;
		ctx.ui.notify(
			`Compaction: ${tokens.toLocaleString()} tok ≥ ${threshold.toLocaleString()} tok threshold (${triggerPercent}% ctx, ${minimumTokens.toLocaleString()} floor) — compacting`,
			"info",
		);
		ctx.compact({
			onComplete: (result) => {
				compacting = false;
				const decision = resumeDecisionAfterCompaction({
					estimatedTokensAfter: result.estimatedTokensAfter,
					threshold,
					idle: ctx.isIdle(),
					hasPending: ctx.hasPendingMessages(),
				});

				if (decision === "loop") {
					// Still over the line (e.g. large minimumTokens floor on a small model).
					// Latch the auto-trigger off so the resume turn doesn't re-fire
					// agent_settled and compact every turn. Reset by /compact or new session.
					triggerDisabled = true;
					ctx.ui.notify(
						`Compaction: ${(result.estimatedTokensAfter ?? 0).toLocaleString()} tok still ≥ ${threshold.toLocaleString()} tok threshold — auto-trigger disabled for this session`,
						"warning",
					);
					return;
				}

				if (decision === "skip") {
					// User is already driving; skipping avoids colliding with their in-flight
					// prompt and avoids overriding an explicit redirect. The fresh summary is
					// already in context, so the agent continues without a nudge.
					ctx.ui.notify("Compaction: resume nudge skipped (your prompt is in flight)", "info");
					return;
				}

				// Idle: nudge the agent to pick its task back up. Visible as a normal user
				// message in the transcript (no hidden automation). deliverAs "followUp" is
				// a backstop for the narrow await-window where a prompt starts between the
				// isIdle() check and this send; pi swallows a residual rejection into its
				// own emitError, so it can't crash the session. The try/catch only guards a
				// stale-ctx throw from sendUserMessage.
				ctx.ui.notify("Compaction: resuming task", "info");
				try {
					pi.sendUserMessage(RESUME_NUDGE, { deliverAs: "followUp" });
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					ctx.ui.notify(`Compaction: resume nudge skipped (${message})`, "warning");
				}
			},
			onError: (err) => {
				compacting = false;
				ctx.ui.notify(`Compaction trigger failed: ${err.message}`, "error");
			},
		});
	});
}
