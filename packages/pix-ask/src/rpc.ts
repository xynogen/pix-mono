import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Params } from "./schema.ts";
import { SENTINEL_FREEFORM } from "./schema.ts";
import type { QuestionAnswer, QuestionnaireResult } from "./types.ts";

// ── RPC / non-TUI fallback ─────────────────────────────────────────────
// Used when ctx.hasUI is false (headless / JSON / print mode).

export async function rpcFallback(
	ui: Pick<ExtensionUIContext, "select" | "input">,
	params: Params,
	signal?: AbortSignal,
): Promise<QuestionnaireResult> {
	const answers: QuestionAnswer[] = [];
	let cancelled = false;

	for (let i = 0; i < params.questions.length; i++) {
		if (signal?.aborted) {
			cancelled = true;
			break;
		}
		const q = params.questions[i];
		if (!q) break;
		const header = q.header;

		if (q.multiSelect) {
			const lines = q.options.map((o, idx) => `${idx + 1}. ${o.label} — ${o.description}`);
			const raw = await ui.input(
				`${header}: ${q.question}\n\n${lines.join("\n")}\n\nEnter numbers separated by commas:`,
				"e.g. 1,3",
				{ signal },
			);
			if (signal?.aborted || raw == null) {
				cancelled = true;
				break;
			}
			const indices = [
				...new Set(
					String(raw)
						.split(",")
						.map((s) => Number(s.trim()))
						.filter((n) => Number.isInteger(n) && n >= 1 && n <= q.options.length),
				),
			];
			const selected = indices.map((n) => q.options[n - 1]?.label ?? "");
			if (selected.length > 0) {
				answers.push({
					questionIndex: i,
					question: q.question,
					kind: "multi",
					answer: null,
					selected,
				});
			} else {
				cancelled = true;
				break;
			}
		} else {
			const items = q.options.map((o) => `${o.label} — ${o.description}`);
			items.push(SENTINEL_FREEFORM);
			const chosen = await ui.select(`${header}: ${q.question}`, items, { signal });
			if (signal?.aborted || chosen == null) {
				cancelled = true;
				break;
			}
			if (chosen === SENTINEL_FREEFORM) {
				const text = await ui.input(q.question, "Type your answer...", { signal });
				if (signal?.aborted || text == null) {
					cancelled = true;
					break;
				}
				answers.push({
					questionIndex: i,
					question: q.question,
					kind: "custom",
					answer: String(text),
				});
			} else {
				const opt = q.options.find(
					(o) => chosen === o.label || `${o.label} — ${o.description}` === chosen,
				);
				answers.push({
					questionIndex: i,
					question: q.question,
					kind: "option",
					answer: opt?.label ?? String(chosen),
				});
			}
		}
	}

	return { answers, cancelled };
}
