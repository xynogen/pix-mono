import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import type { QuestionData } from "./schema.js";

// ── Color helpers ──────────────────────────────────────────────────────

export function borderColor(theme: Theme): (s: string) => string {
	return (s: string) => theme.fg("accent", s);
}

export function dim(theme: Theme): (s: string) => string {
	return (s: string) => theme.fg("dim", s);
}

// ── TabBar ─────────────────────────────────────────────────────────────

export class TabBar implements Component {
	private questions: QuestionData[];
	private activeIndex: number;
	private theme: Theme;

	constructor(questions: QuestionData[], activeIndex: number, theme: Theme) {
		this.questions = questions;
		this.activeIndex = activeIndex;
		this.theme = theme;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const t = this.theme;
		const inner = Math.max(10, width - 2);

		const parts: string[] = [];
		for (let i = 0; i < this.questions.length; i++) {
			const active = i === this.activeIndex;
			const num = `${i + 1}`;
			const tag = `${num}.${this.questions[i]?.header}`;
			parts.push(active ? t.fg("accent", t.bold(tag)) : t.fg("dim", tag));
		}
		const line = parts.join(t.fg("muted", "  "));
		return [
			truncateToWidth(
				t.fg("accent", "╭─") +
					line +
					t.fg("accent", `${"─".repeat(Math.max(0, inner - line.length - 1))}╮`),
				width,
				"",
			),
		].filter(Boolean);
	}
}
