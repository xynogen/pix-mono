/** /model picker rows: chat models ranked by benchmark, classifier/image models in list order. */

import { benchScoreColor, lookupBenchmark, lookupModelsDev } from "@xynogen/pix-data";
import type { SelectItem } from "@xynogen/pix-pretty/tui";
import { visibleWidth } from "@xynogen/pix-pretty/tui";
import type { FgTheme } from "@xynogen/pix-pretty/types";
import { dotJoin } from "@xynogen/pix-pretty/utils";
import {
	benchStars,
	CLASSIFIER_VALUE_PREFIX,
	classifierProtocol,
	fmtCost,
	fmtCtx,
	IMAGE_VALUE_PREFIX,
	type ModelSearchLookup,
	type ModelTab,
	normalizeModelText,
	resolveContextWindow,
} from "./lib.ts";

export type PickerModel = {
	provider: string;
	id: string;
	name?: string;
	api?: string;
	contextWindow?: number;
};

type ChatRow<M extends PickerModel> = {
	m: M;
	dev: ReturnType<typeof lookupModelsDev>;
	bench: ReturnType<typeof lookupBenchmark>;
	// Rank among the user's *available* models, not the global catalog.
	localRank: number | null;
	// Sort tier: 0 scored, 1 benched-but-unscored, 2 off-catalog.
	tier: 0 | 1 | 2;
};

export function buildChatRows<M extends PickerModel>(models: readonly M[]): ChatRow<M>[] {
	const rows: ChatRow<M>[] = models.map((m) => {
		const bench = lookupBenchmark(m.id);
		const tier = !bench
			? 2 // off-catalog → absolute bottom (no rank)
			: bench.overallScore == null
				? 1 // benched, unscored → middle
				: 0; // scored → top
		return { m, dev: lookupModelsDev(m.provider, m.id), bench, localRank: null, tier };
	});

	// Mirror sortModels() — score-desc within tier 0, name-asc otherwise.
	rows.sort((a, b) => {
		if (a.tier !== b.tier) return a.tier - b.tier;
		if (a.tier === 0) {
			const sa = a.bench?.overallScore ?? -1;
			const sb = b.bench?.overallScore ?? -1;
			if (sa !== sb) return sb - sa;
		}
		return (a.m.name ?? a.m.id).localeCompare(b.m.name ?? b.m.id);
	});

	// Local rank = position among scored available models (best pickable = #1).
	let localRank = 0;
	for (const row of rows) if (row.bench) row.localRank = ++localRank;
	return rows;
}

export type PickerSource = {
	chat: readonly PickerModel[];
	classifiers: readonly PickerModel[];
	images: readonly PickerModel[];
};

export type PickerData = ModelSearchLookup & { items: SelectItem[]; widestLabel: number };

function tabEntries(tab: ModelTab, source: PickerSource) {
	if (tab === "chat")
		return buildChatRows(source.chat).map(({ m, dev, bench, localRank }) => ({
			m,
			dev,
			bench,
			rank: localRank,
			value: `${m.provider}/${m.id}`,
			text: `${m.id} ${m.name ?? ""}`,
			tag: "",
		}));
	const prefix = tab === "classifier" ? CLASSIFIER_VALUE_PREFIX : IMAGE_VALUE_PREFIX;
	return (tab === "classifier" ? source.classifiers : source.images).map((m, i) => {
		const tag = tab === "classifier" ? classifierProtocol(m.api ?? "") : "";
		return {
			m,
			dev: lookupModelsDev(m.provider, m.id),
			bench: lookupBenchmark(m.id),
			// Non-chat models have no benchmark rank; number them in list order.
			rank: i + 1,
			value: `${prefix}${m.provider}/${m.id}`,
			text: `${m.id} ${m.name ?? ""} ${tag}`,
			tag,
		};
	});
}

/** Select items plus the search lookup for one tab. `currentValue` gets the ▶ marker. */
export function buildPickerData(
	tab: ModelTab,
	source: PickerSource,
	theme: FgTheme,
	currentValue: string | undefined,
): PickerData {
	const mute = (s: string) => theme.fg("muted", s);
	const entries = tabEntries(tab, source);
	const maxRankWidth = Math.max(1, ...entries.map((e) => String(e.rank ?? "").length));
	const maxCostWidth = Math.max("free".length, ...entries.map((e) => fmtCost(e.dev).length));
	const rankByValue = new Map<string, number>();
	const searchTextByValue = new Map<string, string>();
	const normalizedByValue = new Map<string, string>();

	const items: SelectItem[] = entries.map(({ m, dev, bench, rank, value, text, tag }) => {
		if (rank) rankByValue.set(value, rank);
		searchTextByValue.set(value, text);
		normalizedByValue.set(value, normalizeModelText(text));
		const rankCell = !rank
			? mute("—".padEnd(maxRankWidth))
			: tab === "chat"
				? theme.fg(benchScoreColor(bench?.overallScore), String(rank).padEnd(maxRankWidth))
				: mute(String(rank).padEnd(maxRankWidth));
		const marker = value === currentValue ? theme.fg("accent", "▶") : " ";
		const nameColor = bench ? benchScoreColor(bench.overallScore) : "accent";
		const label = `${marker} ${mute("#")}${rankCell} ${theme.fg(nameColor, m.id)}`;
		const ctxRaw = fmtCtx(resolveContextWindow(m, dev?.limit?.context));
		const rawCost = fmtCost(dev);
		const costSeg =
			rawCost === "—"
				? mute("—".padEnd(maxCostWidth))
				: rawCost === "free"
					? mute("free".padEnd(maxCostWidth))
					: theme.fg("success", rawCost.padEnd(maxCostWidth));
		let benchSeg = "";
		if (bench) {
			const scoreColor = benchScoreColor(bench.overallScore);
			const { filled, empty } = benchStars(bench.overallScore);
			const stars = theme.fg(scoreColor, "★".repeat(filled)) + mute("☆".repeat(empty));
			benchSeg = `⚡${theme.fg(scoreColor, String(bench.overallScore ?? "?"))} ${stars}`;
		}
		return {
			value,
			label,
			description: dotJoin(
				[mute(ctxRaw.padStart(4)), costSeg, [benchSeg, tag && mute(tag)].filter(Boolean).join(" ")],
				mute,
			),
		};
	});
	return {
		items,
		rankByValue,
		searchTextByValue,
		normalizedByValue,
		widestLabel: items.reduce((width, item) => Math.max(width, visibleWidth(item.label)), 0),
	};
}

/** Non-chat rows are informational: picking one explains how to call it instead. */
export function nonChatNotice(value: string): string | undefined {
	if (value.startsWith(CLASSIFIER_VALUE_PREFIX))
		return `${value.slice(CLASSIFIER_VALUE_PREFIX.length)} is a classifier model, not a chat model. Call it with models.classify() in codemode or ctx.modelRegistry.classify().`;
	if (value.startsWith(IMAGE_VALUE_PREFIX))
		return `${value.slice(IMAGE_VALUE_PREFIX.length)} is an image model, not a chat model. Call it with models.generateImages() in codemode.`;
	return undefined;
}
