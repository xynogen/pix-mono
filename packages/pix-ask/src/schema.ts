import { type Static, Type } from "typebox";

// ── Constants ──────────────────────────────────────────────────────────

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER_LENGTH = 16;
export const MAX_LABEL_LENGTH = 60;

export const SENTINEL_FREEFORM = "Type something.";
export const SENTINEL_CHAT = "Chat about this";
export const SENTINEL_NEXT = "Confirm";

export const SPLIT_PANE_MIN_WIDTH = 84;
export const SEPARATOR = " │ ";

// ── Schemas ────────────────────────────────────────────────────────────

export const OptionSchema = Type.Object({
	label: Type.String({
		maxLength: MAX_LABEL_LENGTH,
		description: `MAX ${MAX_LABEL_LENGTH} CHARACTERS. Display text for this option. Concise (1-5 words).`,
	}),
	description: Type.String({
		description: "Explanation of what this option means or trade-offs.",
	}),
	preview: Type.Optional(
		Type.String({
			description: "Optional markdown preview for side-by-side layout (single-select only).",
		}),
	),
});

export const QuestionSchema = Type.Object({
	question: Type.String({
		description: "Clear, specific question ending with ?",
	}),
	header: Type.String({
		maxLength: MAX_HEADER_LENGTH,
		description: `MAX ${MAX_HEADER_LENGTH} CHARS — short chip/tag. E.g. "Auth method", "Approach".`,
	}),
	options: Type.Array(OptionSchema, {
		minItems: MIN_OPTIONS,
		maxItems: MAX_OPTIONS,
		description: "2-4 options. 'Type something.' is auto-appended for single-select.",
	}),
	multiSelect: Type.Optional(
		Type.Boolean({
			default: false,
			description: "Allow multiple selections. Suppresses 'Type something.' row.",
		}),
	),
});

export const QuestionsSchema = Type.Array(QuestionSchema, {
	minItems: 1,
	maxItems: MAX_QUESTIONS,
	description: "1-4 questions",
});

export const ParamsSchema = Type.Object({ questions: QuestionsSchema });

export type OptionData = Static<typeof OptionSchema>;
export type QuestionData = Static<typeof QuestionSchema>;
export type Params = Static<typeof ParamsSchema>;
