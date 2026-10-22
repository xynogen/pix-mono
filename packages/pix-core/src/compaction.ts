/**
 * pix-core compaction — replaces pi's built-in compaction so the prompt and
 * trigger are ours to experiment with.
 *
 * Two independent levers (see AGENTS.md product constraints):
 *
 *   1. Summary prompt — ALWAYS ours. `session_before_compact` fires for every
 *      compaction (manual, threshold, overflow); we generate the summary with
 *      the CURRENT conversation model (no silent routing) using summaryPrompt()
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

import { contentText, retryAssistantCall, type ThinkingLevel } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ContextEditableContent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { getErrorMessage } from "@xynogen/pix-pretty/utils";
import { config } from "@xynogen/pix-runtime/config";
import { compactionSection } from "@xynogen/pix-runtime/sections";

// ── Editable summary prompt ──────────────────────────────────────────────────
// Keep-recent-turns strategy: summarize the OLD span into high-signal notes;
// pi keeps recent turns verbatim (via firstKeptEntryId). This matches current
// context-engineering guidance — recency is highest-signal, and "context rot"
// makes full-history replacement risky. Tune freely.
//
// Adopted from pi 1.4.0's own summarizer: a system prompt that forbids
// continuing the chat, data first and instructions last, /compact focus text,
// no fixed output cap (the model's own limit), the current thinking level,
// transient-error retry, and refusing truncated (`length`) summaries.
// Kept ours: one call for a split turn (pi makes two) and file lists that
// carry across compactions, which pi drops for extension-made summaries.
const SYSTEM_PROMPT =
	"You are a context summarization assistant. Read the conversation between a user and an AI assistant and produce the structured summary requested. Do NOT continue the conversation or answer its questions. Output ONLY the summary.";

export function summaryPrompt(p: {
	conversation: string;
	turnPrefix?: string;
	previousSummary?: string;
	customInstructions?: string;
}): string {
	const blocks: string[] = [];
	if (p.conversation) blocks.push(`<conversation>\n${p.conversation}\n</conversation>`);
	if (p.turnPrefix) blocks.push(`<turn-prefix>\n${p.turnPrefix}\n</turn-prefix>`);
	if (p.previousSummary)
		blocks.push(`<previous-summary>\n${p.previousSummary}\n</previous-summary>`);

	const prior = p.previousSummary
		? " Fold <previous-summary> in: keep what still matters, update Progress and Next Steps, do not repeat it verbatim."
		: "";
	const split = p.turnPrefix
		? "\n\n<turn-prefix> is the start of the current turn; its later messages are kept verbatim. Add a `## Turn Context` section with that turn's request and the progress shown in it."
		: "";
	const focus = p.customInstructions?.trim()
		? `\n\nAdditional focus: ${p.customInstructions.trim()}`
		: "";

	return `${blocks.join("\n\n")}

Summarize the OLDER part of this coding session above. Recent turns are kept verbatim after your summary, so capture only what they would otherwise lose.${prior}

Produce compact, high-signal markdown with these sections (omit a section if empty):

## Goal
## Constraints & Preferences
## Progress (Done / In Progress / Blocked)
## Key Decisions (with rationale)
## Next Steps
## Critical Context (facts, paths, values needed to continue)

Be terse. Prefer names, paths, numbers over prose. No filler. Preserve exact file paths, function names, and error messages.${split}${focus}`;
}

// ── File lists ───────────────────────────────────────────────────────────────────
// Same <read-files>/<modified-files> tags pi appends. Pi rebuilds them from
// entry details only for its own compactions, so we carry them through the
// previous summary text instead — that works for both pi's and ours.
const FILE_TAGS = /\n*<(read-files|modified-files)>\n([\s\S]*?)\n<\/\1>/g;

export function mergeFileLists(
	fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> },
	previousSummary: string | undefined,
): { readFiles: string[]; modifiedFiles: string[]; previousSummary: string | undefined } {
	const read = new Set(fileOps.read);
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	for (const [, tag, body] of previousSummary?.matchAll(FILE_TAGS) ?? []) {
		const into = tag === "read-files" ? read : modified;
		for (const line of body?.split("\n") ?? []) if (line.trim()) into.add(line.trim());
	}
	return {
		readFiles: [...read].filter((f) => !modified.has(f)).sort(),
		modifiedFiles: [...modified].sort(),
		previousSummary: previousSummary?.replace(FILE_TAGS, "").trim() || undefined,
	};
}

export function formatFileLists(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	if (modifiedFiles.length)
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	return sections.length ? `\n\n${sections.join("\n\n")}` : "";
}

/** Why a summary response must not become a checkpoint, or undefined when it is usable. */
export function summaryFailure(response: {
	stopReason: string;
	errorMessage?: string;
	content: { type: string }[];
}): string | undefined {
	if (response.stopReason === "error") return response.errorMessage || "unknown error";
	if (response.stopReason === "length") return "hit the output limit; summary incomplete";
	if (response.content.some((c) => c.type === "toolCall")) return "model tried to call a tool";
	return undefined;
}

// ponytail: mirrors pi's default `retry` settings; extensions cannot read
// settings.retry. Move to the `compaction` config section if someone tunes it.
const SUMMARY_RETRY = { enabled: true, maxRetries: 3, baseDelayMs: 2000 };

export function compactionThresholdTokens(
	contextWindow: number,
	triggerPercent: number,
	minimumTokens: number,
): number {
	const cw = Number.isFinite(contextWindow) ? Math.max(0, Math.floor(contextWindow)) : 0;
	const pct = Number.isFinite(triggerPercent) ? Math.min(100, Math.max(0, triggerPercent)) : 0;
	const floor = Number.isFinite(minimumTokens) ? Math.max(0, Math.round(minimumTokens)) : 100_000;
	return Math.max(floor, Math.ceil((cw * pct) / 100));
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

// Pi cuts compaction only at message boundaries, so one huge message (a pasted
// HAR/log, a giant tool result) can't be summarized away: "Nothing to compact".
// Over threshold we instead trim oversized text to head+tail via a visible,
// append-only context_edit — the original stays in the session file.
// ponytail: fixed char limits (~20k tok kept per message); make them config if
// someone needs to tune per model.
const MAX_MESSAGE_CHARS = 80_000;
const KEEP_CHARS = 20_000;

type TextOrImage = { type: string; text?: string };

/** Head+tail trim of oversized text. Undefined when the text already fits. */
export function truncateLargeText(text: string): string | undefined {
	if (text.length <= MAX_MESSAGE_CHARS) return undefined;
	const cut = text.length - 2 * KEEP_CHARS;
	return `${text.slice(0, KEEP_CHARS)}\n\n[… ${cut.toLocaleString()} chars trimmed by pix compaction (original kept in session file) …]\n\n${text.slice(-KEEP_CHARS)}`;
}

/** Trimmed copy of user/tool-result content, or undefined when nothing is oversized. */
export function shrinkContent(
	content: string | TextOrImage[],
): { content: string | TextOrImage[]; saved: number } | undefined {
	if (typeof content === "string") {
		const t = truncateLargeText(content);
		return t === undefined ? undefined : { content: t, saved: content.length - t.length };
	}
	let saved = 0;
	const next = content.map((part) => {
		if (part.type !== "text" || typeof part.text !== "string") return part;
		const t = truncateLargeText(part.text);
		if (t === undefined) return part;
		saved += part.text.length - t.length;
		return { ...part, text: t };
	});
	return saved > 0 ? { content: next, saved } : undefined;
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

		const toText = (m: typeof preparation.messagesToSummarize) =>
			m.length ? serializeConversation(convertToLlm(m)) : "";
		const files = mergeFileLists(preparation.fileOps, preparation.previousSummary);
		const prompt = summaryPrompt({
			conversation: toText(preparation.messagesToSummarize),
			turnPrefix: toText(preparation.turnPrefixMessages),
			previousSummary: files.previousSummary,
			customInstructions: event.customInstructions,
		});
		const level = pi.getThinkingLevel?.();
		const reasoning =
			model.reasoning && level && level !== "off" ? (level as ThinkingLevel) : undefined;
		const count = preparation.messagesToSummarize.length + preparation.turnPrefixMessages.length;
		ctx.ui.notify(
			`Compaction (${reason}): summarizing ${count} msgs / ${preparation.tokensBefore.toLocaleString()} tok with ${model.id}${reasoning ? ` (thinking ${reasoning})` : ""}`,
			"info",
		);

		try {
			const response = await retryAssistantCall(
				() =>
					completeSimple(
						model,
						{
							systemPrompt: SYSTEM_PROMPT,
							messages: [
								{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() },
							],
						},
						// No maxTokens: the model's own output limit, so long reasoning cannot
						// starve the summary (pi #9512).
						{
							apiKey: auth.apiKey,
							headers: auth.headers,
							env: auth.env,
							signal,
							cacheRetention: "none",
							reasoning,
						},
					),
				SUMMARY_RETRY,
				signal,
				{
					onRetryScheduled: (attempt, max, delayMs, error) =>
						ctx.ui.notify(
							`Compaction: retry ${attempt}/${max} in ${Math.round(delayMs / 1000)}s (${error})`,
							"warning",
						),
				},
			);
			if (signal.aborted) return;

			const failure = summaryFailure(response);
			if (failure) {
				ctx.ui.notify(`Compaction: summary failed (${failure}); using built-in`, "warning");
				return;
			}
			const summary = contentText(response.content).trim();
			if (!summary) {
				ctx.ui.notify("Compaction: empty summary; using built-in", "warning");
				return;
			}

			return {
				compaction: {
					summary: summary + formatFileLists(files.readFiles, files.modifiedFiles),
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					usage: response.usage,
					details: { readFiles: files.readFiles, modifiedFiles: files.modifiedFiles },
				},
			};
		} catch (error) {
			if (signal.aborted) return;
			const message = getErrorMessage(error);
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

	// Runs before agent_settled; committed edits shrink the context the trigger
	// below measures, so a single oversized message no longer blocks compaction.
	pi.on("agent_before_settle", (event, ctx) => {
		const { triggerPercent, minimumTokens } = config(compactionSection);
		if (triggerPercent <= 0) return;
		const usage = ctx.getContextUsage?.();
		if (!usage || usage.tokens === null) return;
		if (
			usage.tokens < compactionThresholdTokens(usage.contextWindow, triggerPercent, minimumTokens)
		)
			return;

		const edits: typeof event.entries = [];
		let saved = 0;
		for (const { sourceEntry, messages } of event.context.contextEntries) {
			const msg = messages[0];
			const editable =
				sourceEntry.type === "custom_message" ||
				(sourceEntry.type === "message" && (msg?.role === "user" || msg?.role === "toolResult"));
			if (!editable || !msg || !("content" in msg)) continue;
			const shrunk = shrinkContent(msg.content as string | TextOrImage[]);
			if (!shrunk) continue;
			saved += shrunk.saved;
			edits.push({
				type: "context_edit",
				targetId: sourceEntry.id,
				replacement: { content: shrunk.content as ContextEditableContent },
			});
		}
		if (edits.length === 0) return;
		ctx.ui.notify(
			`Compaction: trimmed ${edits.length} oversized message(s), ~${Math.round(saved / 4).toLocaleString()} tok (head+tail kept; originals stay in session file)`,
			"info",
		);
		return { entries: [...event.entries, ...edits] };
	});

	pi.on("agent_settled", (event, ctx) => {
		// Escape means the user wants control back, not a surprise compaction.
		if (event.aborted || compacting || triggerDisabled) return;
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

				// Loop check is token-based (timing-independent) — decide it now.
				if ((result.estimatedTokensAfter ?? 0) >= threshold) {
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

				// Defer the resume/skip decision by one macrotask. A message the user
				// typed DURING compaction lives in the TUI's own compactionQueuedMessages
				// buffer, which ctx.hasPendingMessages()/isIdle() cannot see. The host
				// flushes that buffer on compaction_end by starting a new turn; deferring
				// lets that turn's prompt() microtask chain flip the session to streaming
				// first, so the re-read below reports busy and we skip the nudge. Without
				// this, our nudge races the user's steer, wins the turn, and leaves their
				// message queued "stuck" behind it — and re-points the agent at the old task.
				// ponytail: setTimeout(0) drains microtasks; if the flush's prompt() blocks
				// on a real-async auth check it may still be idle here and the nudge fires
				// (user steer then queues behind it). Rare; upgrade path is a host API that
				// exposes the TUI compaction buffer or a post-flush event.
				setTimeout(() => {
					const decision = resumeDecisionAfterCompaction({
						estimatedTokensAfter: 0, // loop already handled above
						threshold,
						idle: ctx.isIdle(),
						hasPending: ctx.hasPendingMessages(),
					});

					if (decision === "skip") {
						// User is already driving (in-flight or freshly flushed prompt); skipping
						// avoids colliding with it and avoids overriding an explicit redirect. The
						// fresh summary is already in context, so the agent continues without a nudge.
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
						const message = getErrorMessage(err);
						ctx.ui.notify(`Compaction: resume nudge skipped (${message})`, "warning");
					}
				}, 0);
			},
			onError: (err) => {
				compacting = false;
				// Pi already reported the failure (compaction_end). "Nothing to compact" /
				// "Already compacted" will fail identically next turn, so latch off instead
				// of re-firing every agent_settled. Oversized messages are trimmed in
				// agent_before_settle, so this is now only a backstop.
				if (!/nothing to compact|already compacted/i.test(err.message)) return;
				triggerDisabled = true;
				ctx.ui.notify(
					`Compaction: ${tokens.toLocaleString()} tok but nothing older to summarize. Auto-trigger disabled for this session; start a new session if context keeps growing.`,
					"warning",
				);
			},
		});
	});
}
