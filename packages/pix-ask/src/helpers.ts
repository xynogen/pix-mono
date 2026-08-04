import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import type { OptionData, QuestionData } from "./schema.js";
import { SENTINEL_CHAT, SENTINEL_FREEFORM, SENTINEL_NEXT } from "./schema.js";
import type { AnswerKind, QuestionAnswer } from "./types.js";

// ── Markdown theme ─────────────────────────────────────────────────────

export function safeMarkdownTheme(): MarkdownTheme | undefined {
	try {
		const md = getMarkdownTheme();
		if (!md) return undefined;
		md.bold("");
		return md;
	} catch {
		return undefined;
	}
}

// ── Option / question helpers ──────────────────────────────────────────

export function hasAnyPreview(q: QuestionData): boolean {
	return q.options.some((o) => typeof o.preview === "string" && o.preview.length > 0);
}

/**
 * Which sentinel rows are auto-appended for a question.
 *
 * Freeform ("Type something.") is ALWAYS offered so the user can reject every
 * option and answer in their own words — regardless of preview or multi-select.
 * Multi-select additionally gets a "Confirm" row to commit the checked options.
 */
export function sentinelsFor(q: QuestionData): Array<{ kind: string; label: string }> {
	const out: Array<{ kind: string; label: string }> = [];
	out.push({ kind: "other", label: SENTINEL_FREEFORM });
	if (q.multiSelect) {
		out.push({ kind: "next", label: SENTINEL_NEXT });
	}
	return out;
}

// ── Answer formatting ──────────────────────────────────────────────────

export function formatAnswerScalar(a: QuestionAnswer): string {
	if (a.kind === "multi") return (a.selected ?? []).join(", ");
	if (a.kind === "custom") return a.answer ?? "(custom)";
	if (a.kind === "chat") return "(chat)";
	return a.answer ?? "(selected)";
}

export function buildResponseText(answers: QuestionAnswer[], questions: QuestionData[]): string {
	const segs: string[] = [];
	for (const a of answers) {
		const q = questions[a.questionIndex]?.question ?? `Q${a.questionIndex + 1}`;
		let s = `"${q}"="${formatAnswerScalar(a)}"`;
		if (a.preview) s += `. selected preview: ${a.preview}`;
		segs.push(s);
	}
	return segs.length ? `User answered: ${segs.join(". ")}.` : "User declined to answer questions.";
}

// ── Scroll indicator ───────────────────────────────────────────────────

export function scrollIndicator(index: number, total: number): string {
	if (total <= 1) return "";
	const pos = Math.round((index / (total - 1)) * 6);
	const bar = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦"][pos] ?? "·";
	return ` ${bar} ${index + 1}/${total}`;
}

export type { AnswerKind, OptionData, QuestionData };
// Re-export sentinel constants so callers don't need to import schema directly
export { SENTINEL_CHAT, SENTINEL_FREEFORM, SENTINEL_NEXT };
