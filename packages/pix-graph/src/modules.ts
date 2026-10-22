import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomicSync } from "@xynogen/pix-runtime/atomic-write";
import type { GraphData, GraphNode } from "./analyzer.ts";
import { sharePrefix, tokenize } from "./query.ts";
import { boundaries } from "./report.ts";

/** Bump when the card format or the summary instructions change: every summary turns stale. */
export const SUMMARY_PROMPT_VERSION = 1;
export const SUMMARY_MAX_CHARS = 1200;

/** Deterministic, citation-ready facts about one module (workspace package or top folder). */
export interface ModuleCard {
	module: string;
	files: string[];
	tests: number;
	symbols: number;
	/** Non-test files nothing imports: likely entry points (index, cli, extension). */
	entries: string[];
	/** Entities other modules call, most-called first. */
	apis: string[];
	dependsOn: string[];
	usedBy: string[];
	/** Card rendered as text: the evidence the summary must rest on. */
	text: string;
	/** Hash of `text` + prompt version; a summary is current only while this matches. */
	hash: string;
}

export interface StoredSummary {
	summary: string;
	evidence_hash: string;
	model: string;
	prompt_version: number;
	updated_at: string;
}

export interface SummaryFile {
	version: 1;
	modules: Record<string, StoredSummary>;
}

// Test files across ecosystems: foo.test.ts, foo_test.go, test_foo.py, FooTest.java, tests/.
const TEST_FILE =
	/(?:^|\/)(?:tests?|__tests__|spec)\/|(?:^|\/)test_[^/]*$|[._-](?:test|spec)\.[^/]+$|Tests?\.[^/.]+$/;

/** Module key: workspace package name, else the first path segment. */
export function moduleOf(n: GraphNode): string | undefined {
	if (typeof n.package === "string") return n.package;
	const file = n.source_file ?? "";
	if (!file) return undefined;
	return file.includes("/") ? (file.split("/")[0] ?? file) : ".";
}

function byText(a: string, b: string): number {
	if (a < b) return -1;
	return a > b ? 1 : 0;
}

/** Build one evidence card per module from the cleaned graph. Sorted by module name. */
export function moduleCards(graph: GraphData): ModuleCard[] {
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	const groups = new Map<string, GraphNode[]>();
	for (const n of graph.nodes) {
		const m = moduleOf(n);
		if (m) groups.set(m, [...(groups.get(m) ?? []), n]);
	}
	const imported = new Set<string>();
	const apiCalls = new Map<string, number>();
	for (const l of graph.links) {
		if (l.relation === "imports") imported.add(l.target);
		if (l.relation !== "calls") continue;
		const s = byId.get(l.source);
		const t = byId.get(l.target);
		if (s && t && moduleOf(s) !== moduleOf(t)) apiCalls.set(t.id, (apiCalls.get(t.id) ?? 0) + 1);
	}
	const cards = boundaries(graph, moduleOf);
	const edge = (c: (typeof cards)[number], other: string) =>
		`${other} (${c.imports} imports, ${c.calls} calls${c.apis.length > 0 ? `: ${c.apis.slice(0, 4).join(", ")}` : ""})`;

	return [...groups]
		.sort((a, b) => byText(a[0], b[0]))
		.map(([module, members]) => {
			const fileNodes = members.filter((n) => !n.source_location);
			const all = fileNodes.map((n) => n.source_file ?? n.id).sort(byText);
			const files = all.filter((f) => !TEST_FILE.test(f));
			const entries = fileNodes
				.filter((n) => !imported.has(n.id) && !TEST_FILE.test(n.source_file ?? ""))
				.map((n) => n.source_file ?? n.id)
				.sort(byText);
			const apis = members
				.filter((n) => apiCalls.has(n.id))
				.sort((a, b) => (apiCalls.get(b.id) ?? 0) - (apiCalls.get(a.id) ?? 0) || byText(a.id, b.id))
				.map((n) => n.label);
			const dependsOn = cards.filter((c) => c.from === module).map((c) => edge(c, c.to));
			const usedBy = cards.filter((c) => c.to === module).map((c) => edge(c, c.from));
			const symbols = members.length - fileNodes.length;
			const tests = all.length - files.length;
			const list = (label: string, items: string[], max: number) =>
				items.length === 0
					? []
					: [
							`${label}: ${items.slice(0, max).join("; ")}${items.length > max ? `; … ${items.length - max} more` : ""}`,
						];
			const text = [
				`module ${module} — ${files.length} files (+${tests} tests), ${symbols} symbols`,
				...list("entry files", entries, 6),
				...list("key APIs used by other modules", apis, 10),
				...list("depends on", dependsOn, 6),
				...list("used by", usedBy, 6),
				...list("files", files, 20),
			].join("\n");
			const hash = createHash("sha256")
				.update(`${SUMMARY_PROMPT_VERSION}\0${text}`)
				.digest("hex")
				.slice(0, 16);
			return { module, files, tests, symbols, entries, apis, dependsOn, usedBy, text, hash };
		});
}

export function loadSummaries(path: string): SummaryFile {
	if (!existsSync(path)) return { version: 1, modules: {} };
	try {
		const data = JSON.parse(readFileSync(path, "utf8")) as Partial<SummaryFile>;
		if (data.version === 1 && data.modules && typeof data.modules === "object") {
			return { version: 1, modules: data.modules };
		}
	} catch {
		// A corrupt sidecar only costs a re-summarize; never block queries on it.
	}
	return { version: 1, modules: {} };
}

/** Cards whose summary is missing, or was written for different evidence or prompt version. */
export function staleCards(cards: ModuleCard[], file: SummaryFile): ModuleCard[] {
	return cards.filter((c) => {
		const s = file.modules[c.module];
		return !s || s.evidence_hash !== c.hash || s.prompt_version !== SUMMARY_PROMPT_VERSION;
	});
}

/**
 * Validate and store one summary. Grounding check: the summary must name the module or at
 * least one entry file, API, or dependency from its card. Returns an error string or the record.
 */
export function storeSummary(
	path: string,
	card: ModuleCard,
	summary: string,
	model: string,
	now = new Date(),
): string | StoredSummary {
	const text = summary.trim();
	if (!text) return "summary is empty.";
	if (text.length > SUMMARY_MAX_CHARS) {
		return `summary is ${text.length} chars; the limit is ${SUMMARY_MAX_CHARS}.`;
	}
	const names = [
		card.module,
		...card.entries.map((f) => f.split("/").at(-1) ?? f),
		...card.apis.map((a) => a.replace(/\(\)$/, "")),
		...[...card.dependsOn, ...card.usedBy].map((d) => d.split(" ")[0] ?? d),
	].filter((n) => n.length > 2);
	if (!names.some((n) => text.includes(n))) {
		return `summary cites nothing from the evidence card. Name the module or one of: ${names.slice(1, 9).join(", ") || card.module}.`;
	}
	const file = loadSummaries(path);
	const record: StoredSummary = {
		summary: text,
		evidence_hash: card.hash,
		model,
		prompt_version: SUMMARY_PROMPT_VERSION,
		updated_at: now.toISOString(),
	};
	file.modules[card.module] = record;
	writeFileAtomicSync(path, `${JSON.stringify(file, null, 2)}\n`);
	return record;
}

/** Ranked modules for a global (architecture) question. */
export interface ModuleHit {
	card: ModuleCard;
	summary?: StoredSummary;
	stale: boolean;
	score: number;
}

/**
 * Global query: rank modules by keyword overlap with name, summary, APIs, and files.
 * Summary terms weigh most (they carry meaning); names next. No model call happens here.
 */
export function globalQuery(
	cards: ModuleCard[],
	file: SummaryFile,
	question: string,
	limit = 3,
): ModuleHit[] {
	const terms = tokenize(question);
	if (terms.length === 0) return [];
	const words = (s: string) =>
		new Set(
			s
				.replace(/(?<=[a-z0-9])(?=[A-Z])/g, " ")
				.toLowerCase()
				.split(/[^a-z0-9]+/)
				.filter(Boolean),
		);
	return cards
		.map((card) => {
			const summary = file.modules[card.module];
			const name = words(card.module);
			const said = words(summary?.summary ?? "");
			const facts = words(
				`${card.apis.join(" ")} ${card.entries.join(" ")} ${card.files.join(" ")}`,
			);
			const hit = (set: Set<string>, t: string) =>
				set.has(t) || [...set].some((w) => sharePrefix(w, t));
			let score = 0;
			for (const t of terms) {
				if (hit(name, t)) score += 4;
				if (hit(said, t)) score += 3;
				if (hit(facts, t)) score += 1;
			}
			const stale = !summary || summary.evidence_hash !== card.hash;
			return { card, ...(summary ? { summary } : {}), stale, score };
		})
		.filter((h) => h.score > 0)
		.sort((a, b) => b.score - a.score || byText(a.card.module, b.card.module))
		.slice(0, limit);
}

/** Rough token estimate (chars / 4) shown next to evidence so the cost is visible up front. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}
