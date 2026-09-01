import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { modalOverlayOptions } from "@xynogen/pix-pretty/modal-frame";
import {
	dotJoin,
	formatCollapsedToolRow,
	hideCollapsedToolCall,
	pluralize,
} from "@xynogen/pix-pretty/utils";
import { withAgentBlock } from "@xynogen/pix-runtime";
import { type CollapseState, tickCollapse } from "@xynogen/pix-runtime/collapse";
import { once } from "@xynogen/pix-runtime/once";
import { buildResponseText } from "./helpers.js";
import { AskQuestionnaire } from "./questionnaire.js";
import { rpcFallback } from "./rpc.js";
import type { Params } from "./schema.js";
import { MAX_OPTIONS, MAX_QUESTIONS, MIN_OPTIONS, ParamsSchema } from "./schema.js";
import type { QuestionAnswer, QuestionnaireResult } from "./types.js";

// ── Re-exports (consumed by tests and single-select-layout) ───────────

export {
	buildResponseText,
	formatAnswerScalar,
	hasAnyPreview,
	sentinelsFor,
} from "./helpers.js";
export type { OptionData, QuestionData } from "./schema.js";
export type {
	AnswerKind,
	QuestionAnswer,
	QuestionnaireResult,
} from "./types.js";

// ── Tool registration ──────────────────────────────────────────────────

export default function registerAsk(pi: ExtensionAPI): void {
	once(pi, "pix-ask", () => {
		pi.registerTool({
			name: "ask_user",
			label: "Ask",
			renderShell: "self",
			description: `Ask the user up to ${MAX_QUESTIONS} structured questions (${MIN_OPTIONS}-${MAX_OPTIONS} options each) when requirements are ambiguous.`,
			promptSnippet: `Ask the user up to ${MAX_QUESTIONS} structured questions (${MIN_OPTIONS}-${MAX_OPTIONS} options each) when requirements are ambiguous`,
			promptGuidelines: [
				"Do not stack multiple ask_user calls back-to-back — group all clarifying questions into one invocation.",
			],
			executionMode: "sequential",
			parameters: ParamsSchema,

			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				if (signal?.aborted) {
					return {
						content: [{ type: "text", text: "Cancelled" }],
						details: { answers: [], cancelled: true },
					};
				}

				// SAFETY: ParamsSchema validates tool input before execute receives it.
				const typed = params as unknown as Params;

				if (!Array.isArray(typed.questions) || typed.questions.length === 0) {
					return {
						content: [{ type: "text", text: "At least one question is required." }],
						isError: true,
						details: { answers: [], cancelled: true },
					};
				}

				if (!ctx.hasUI) {
					const result = await rpcFallback(ctx.ui, typed);
					const text = result.cancelled
						? "User cancelled the questionnaire"
						: buildResponseText(result.answers, typed.questions);
					return { content: [{ type: "text", text }], details: result };
				}

				const result = await withAgentBlock(pi.events, "ask_user", "Waiting for user answer", () =>
					ctx.ui.custom<QuestionnaireResult | null>(
						(tui, theme, keybindings, done) => {
							if (signal) {
								signal.addEventListener("abort", () => done({ answers: [], cancelled: true }), {
									once: true,
								});
							}
							return new AskQuestionnaire(typed, tui, theme, keybindings, done);
						},
						{ overlay: true, overlayOptions: modalOverlayOptions() },
					),
				);

				if (!result || result.cancelled) {
					return {
						content: [{ type: "text", text: "User cancelled the questionnaire" }],
						details: result ?? { answers: [], cancelled: true },
					};
				}

				const text = buildResponseText(result.answers, typed.questions);
				return { content: [{ type: "text", text }], details: result };
			},

			renderCall(args, theme, renderCtx) {
				const text =
					renderCtx?.lastComponent instanceof Text ? renderCtx.lastComponent : new Text("", 0, 0);
				if (
					renderCtx &&
					hideCollapsedToolCall(renderCtx.state as CollapseState, renderCtx.expanded, (value) =>
						text.setText(value),
					)
				)
					return text;
				const questions = Array.isArray(args.questions) ? args.questions : [];
				const count = questions.length;
				const firstQ = questions[0]?.question ?? "";
				const head = `${theme.fg("toolTitle", theme.bold("ask_user"))} ${theme.fg("dim", firstQ)}`;
				text.setText(
					dotJoin([head, theme.fg("muted", pluralize(count, "question"))], (s) =>
						theme.fg("muted", s),
					),
				);
				return text;
			},

			renderResult(result, options, theme, renderCtx) {
				const text =
					renderCtx?.lastComponent instanceof Text ? renderCtx.lastComponent : new Text("", 0, 0);
				const details = result.details as
					| { answers?: QuestionAnswer[]; cancelled?: boolean }
					| undefined;
				if (options.isPartial) {
					text.setText(theme.fg("muted", "Waiting for user input…"));
					return text;
				}
				if (!details || details.cancelled || !details.answers?.length) {
					// Cancellation is a warning outcome, not success — shared row keeps the
					// tool identity and a text label (never color alone) for accessibility.
					text.setText(formatCollapsedToolRow(theme, "ask_user", "", "cancelled", "warning"));
					return text;
				}
				const values = details.answers.map((a) =>
					a.kind === "multi" ? (a.selected ?? []).join(", ") : (a.answer ?? ""),
				);
				const collapsed =
					!!renderCtx &&
					tickCollapse(
						"ask_user",
						renderCtx.state as CollapseState,
						renderCtx.invalidate,
						renderCtx.expanded,
					);
				if (collapsed) {
					text.setText(
						formatCollapsedToolRow(
							theme,
							"ask_user",
							values.join(", "),
							pluralize(details.answers.length, "answer"),
						),
					);
					return text;
				}
				const lines = details.answers.map(
					(a, i) =>
						`${theme.fg("muted", `${a.questionIndex + 1}:`)} ${theme.fg("success", values[i] ?? "")}`,
				);
				const header = `${theme.fg("success", "✓")} ${theme.fg("toolTitle", theme.bold("ask_user"))}`;
				text.setText([header, ...lines].join("\n"));
				return text;
			},
		});
	});
}
