/**
 * data.ts — shared Pi model data layer
 *
 * Two data sources, each its own cached DataSource:
 *   - modelgrep (coding-sorted catalog) — ~/.cache/pi/modelgrep.json (TTL 24h):
 *     context, cost, modalities, capabilities, coding-percentile score, rank.
 *   - BenchLM — ~/.cache/pi/benchlm.json: fallback overall score when modelgrep
 *     has no benchmark for a model (see lookupBenchmark).
 *
 * Cache files are shared across all Pi extensions — whichever extension loads
 * first populates the cache; subsequent extensions read from disk.
 *
 * Usage:
 *   import { modelgrep } from "./data.ts";
 *
 *   const catalog = await modelgrep.get();   // async, fetches if stale
 *   const catalog = modelgrep.getCached();   // sync, disk-only, no fetch
 *
 *   import { lookupModelsDev, lookupBenchmark } from "./data.ts";
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ioTimeoutMs } from "@xynogen/pix-runtime/io";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ModelsDevModel {
	id: string;
	name?: string;
	reasoning?: boolean;
	modalities?: { input?: string[]; output?: string[] };
	limit?: { context?: number; output?: number };
	cost?: {
		input?: number;
		output?: number;
		cache_read?: number;
		cache_write?: number;
	};
}

export type ModelsDevApi = Record<string, { models?: Record<string, ModelsDevModel> }>;

export interface BenchmarkEntry {
	rank: number;
	model: string;
	creator: string;
	sourceType?: string;
	overallScore: number | null;
	categoryScores?: Record<string, number | null>;
	inputPrice: number | null;
	outputPrice: number | null;
}

export interface ModelGrepModel {
	id: string;
	name?: string;
	context_length?: number;
	pricing?: { input?: number; output?: number };
	modality?: { input?: string[]; output?: string[] };
	capabilities?: { reasoning?: boolean };
	benchmarks?: {
		artificial_analysis?: {
			// AA Intelligence Index — authoritative 9-eval composite (~0–65 range).
			intelligence?: number | null;
			coding?: number | null; // 0–100 index
			agentic?: number | null; // 0–100 index
			gpqa?: number | null; // 0–1
			scicode?: number | null; // 0–1
			tau2?: number | null; // 0–1
			hle?: number | null; // 0–1
		};
	};
}

interface ModelGrepResponse {
	data: ModelGrepModel[];
}

// ── DataSource ───────────────────────────────────────────────────────────────

interface DataSourceOptions<T> {
	url: string | (() => string);
	headers?: () => Record<string, string> | undefined;
	cachePath: string;
	ttlMs?: number;
	timeoutMs?: number;
	parse: (raw: unknown) => T;
	parseCache: (data: unknown) => T;
	empty: T;
	label: string;
	skip?: () => boolean;
	/**
	 * Optional override for sources that need multiple requests (pagination).
	 * Returns the merged raw payload, which is then handed to `parse`/cached
	 * exactly as a single response would be.
	 */
	fetchRaw?: (
		url: string,
		headers: Record<string, string> | undefined,
		timeoutMs: number,
	) => Promise<unknown>;
}

export class DataSource<T> {
	private _mem: T | null = null;
	private _inflight: Promise<T> | null = null;
	private readonly opts: Required<Omit<DataSourceOptions<T>, "timeoutMs">> & {
		timeoutMs?: number;
	};

	constructor(opts: DataSourceOptions<T>) {
		this.opts = {
			ttlMs: 24 * 60 * 60 * 1000,
			headers: () => undefined,
			skip: () => false,
			fetchRaw: defaultFetchRaw,
			...opts,
		};
	}

	async get(): Promise<T> {
		if (this._inflight) return this._inflight;
		this._inflight = this._load().finally(() => {
			this._inflight = null;
		});
		return this._inflight;
	}

	getCached(): T {
		if (this._mem) return this._mem;
		try {
			if (existsSync(this.opts.cachePath)) {
				const raw = JSON.parse(readFileSync(this.opts.cachePath, "utf-8")) as {
					data: unknown;
				};
				this._mem = this.opts.parseCache(raw.data);
				return this._mem;
			}
		} catch {
			// No cache file or parse error — return empty, not fatal
		}
		return this.opts.empty;
	}

	private async _load(): Promise<T> {
		if (this.opts.skip()) {
			this._mem = this.opts.empty;
			return this.opts.empty;
		}
		const cached = await this._readCache();
		if (cached !== undefined && Date.now() - cached.ts < this.opts.ttlMs) {
			const val = this.opts.parseCache(cached.data);
			this._mem = val;
			return val;
		}
		try {
			const url = typeof this.opts.url === "function" ? this.opts.url() : this.opts.url;
			const raw = await this.opts.fetchRaw(
				url,
				this.opts.headers(),
				this.opts.timeoutMs ?? ioTimeoutMs(),
			);
			const val = this.opts.parse(raw);
			this._mem = val;
			void this._writeCache(raw);
			return val;
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (cached !== undefined) {
				console.warn(`${this.opts.label} fetch failed, using stale cache: ${msg}`);
				const val = this.opts.parseCache(cached.data);
				this._mem = val;
				return val;
			}
			console.warn(`${this.opts.label} unavailable: ${msg}`);
			return this.opts.empty;
		}
	}

	private async _readCache(): Promise<{ ts: number; data: unknown } | undefined> {
		try {
			const raw = await readFile(this.opts.cachePath, "utf8");
			const parsed = JSON.parse(raw) as { ts: number; data: unknown };
			if (typeof parsed.ts !== "number") return undefined;
			return parsed;
		} catch {
			return undefined;
		}
	}

	private async _writeCache(data: unknown): Promise<void> {
		try {
			await mkdir(dirname(this.opts.cachePath), { recursive: true });
			await writeFile(this.opts.cachePath, JSON.stringify({ ts: Date.now(), data }));
		} catch {
			// Write failure is non-fatal — stale cache used on next run
		}
	}
}

function fetchWithTimeout(
	url: string,
	timeoutMs: number,
	headers?: Record<string, string>,
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	return fetch(url, { signal: controller.signal, headers }).finally(() => clearTimeout(timer));
}

/** Single-request raw fetch — the default DataSource fetch strategy. */
async function defaultFetchRaw(
	url: string,
	headers: Record<string, string> | undefined,
	timeoutMs: number,
): Promise<unknown> {
	const response = await fetchWithTimeout(url, timeoutMs, headers);
	if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
	return response.json();
}

const MODELGREP_PAGE = 200; // modelgrep hard page-size cap
const MODELGREP_MAX_PAGES = 10; // safety bound (~2000 models)

interface ModelGrepPage {
	data?: ModelGrepModel[];
	meta?: { has_more?: boolean; next_offset?: number };
}

/**
 * Paginating fetch for modelgrep: walks `meta.has_more`/`next_offset` and
 * merges every page into one `{ data }` payload so `parse` and the cache see
 * the full catalog as a single response. `url` already carries the query
 * (sort/limit); we only append `&offset=`.
 */
async function fetchModelGrepAll(
	url: string,
	headers: Record<string, string> | undefined,
	timeoutMs: number,
): Promise<{ data: ModelGrepModel[] }> {
	const all: ModelGrepModel[] = [];
	let offset = 0;
	for (let page = 0; page < MODELGREP_MAX_PAGES; page++) {
		const sep = url.includes("?") ? "&" : "?";
		const res = (await defaultFetchRaw(
			`${url}${sep}offset=${offset}`,
			headers,
			timeoutMs,
		)) as ModelGrepPage;
		if (res.data?.length) all.push(...res.data);
		if (!res.meta?.has_more) break;
		offset = res.meta.next_offset ?? offset + MODELGREP_PAGE;
	}
	return { data: all };
}

// ── Cache dir ─────────────────────────────────────────────────────────────────

export const CACHE_DIR = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "pi");

// ── Data sources ──────────────────────────────────────────────────────────────

export const modelgrep = new DataSource<ModelGrepModel[]>({
	label: "modelgrep",
	url: `https://modelgrep.com/api/v1/models?sort=coding&order=desc&limit=${MODELGREP_PAGE}`,
	cachePath: join(CACHE_DIR, "modelgrep.json"),
	fetchRaw: fetchModelGrepAll,
	parse: (raw) => (raw as ModelGrepResponse).data ?? [],
	parseCache: (data) => (data as ModelGrepResponse)?.data ?? [],
	empty: [],
});

// ── BenchLM (fallback coding-score source) ────────────────────────────────────
// Upstream `benchlm.ai` ships a 0–100 `overallScore` per model with category
// breakdown (coding/agentic/reasoning/…). Used as a fallback when modelgrep's
// `benchmarks.artificial_analysis` is null (current state). Same name as
// before the 4dfb443 swap.
interface BenchLMCategoryScores {
	coding?: number | null;
	agentic?: number | null;
	reasoning?: number | null;
}

interface BenchLMRawEntry {
	rank: number;
	model: string;
	creator?: string;
	overallScore: number | null;
	categoryScores?: BenchLMCategoryScores;
}

interface BenchLMResponse {
	lastUpdated?: string;
	mode?: string;
	models?: BenchLMRawEntry[];
}

export const benchlm = new DataSource<BenchLMRawEntry[]>({
	label: "benchlm",
	url: "https://benchlm.ai/api/data/leaderboard",
	cachePath: join(CACHE_DIR, "benchlm.json"),
	parse: (raw) => (raw as BenchLMResponse).models ?? [],
	parseCache: (data) => (data as BenchLMResponse)?.models ?? [],
	empty: [],
});

// ── Lookup helpers ─────────────────────────────────────────────────────────────

function normalize(id: string): string {
	return id
		.toLowerCase()
		.replace(/[:@].*$/, "") // routing suffix (:nitro, @date)
		.replace(/[._]/g, "-") // fold separators: modelgrep `4.5` ↔ Pi routing `4-5`
		.replace(/-\d{8}$/, ""); // trailing -YYYYMMDD
}

function stripPrefix(id: string): string {
	const i = id.lastIndexOf("/");
	return i >= 0 ? id.slice(i + 1) : id;
}

/** Slug = model id without its maker/provider prefix. */
function slugOf(id: string): string {
	return id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
}

/**
 * Generic normalized-index lookup: exact slug → normalized slug → fuzzy
 * prefix overlap. Handles routing suffixes (`:nitro`, `@date`, `-YYYYMMDD`)
 * and maker prefixes (e.g. `tencent/hy3-preview:nitro` → `hy3-preview`).
 */
function findInIndex<T>(id: string, index: Map<string, T>): T | undefined {
	const stripped = stripPrefix(id);
	const direct = index.get(stripped) ?? index.get(normalize(stripped));
	if (direct) return direct;
	const norm = normalize(stripped);
	for (const [key, value] of index) {
		if (key.startsWith(norm) || norm.startsWith(key)) return value;
	}
	return undefined;
}

export function lookupInIndex(
	id: string,
	index: Map<string, ModelsDevModel>,
): ModelsDevModel | undefined {
	return findInIndex(id, index);
}

function toModelsDevModel(g: ModelGrepModel): ModelsDevModel {
	return {
		id: slugOf(g.id),
		name: g.name,
		reasoning: g.capabilities?.reasoning,
		modalities: g.modality,
		limit: { context: g.context_length },
		cost: { input: g.pricing?.input, output: g.pricing?.output },
	};
}

export function buildModelsDevIndex(source: ModelGrepModel[]): Map<string, ModelsDevModel> {
	const index = new Map<string, ModelsDevModel>();
	for (const g of source) {
		const m = toModelsDevModel(g);
		if (!index.has(m.id)) index.set(m.id, m);
		const norm = normalize(m.id);
		if (!index.has(norm)) index.set(norm, m);
	}
	return index;
}

export function lookupModelsDev(_provider: string, id: string): ModelsDevModel | undefined {
	// Provider prefix differs between Pi routing (cc/ds/openrouter) and modelgrep
	// (anthropic/tencent), so join on the model slug only via the normalized index.
	return findInIndex(id, buildModelsDevIndex(modelgrep.getCached()));
}

export async function fetchModelsDevIndex(): Promise<Map<string, ModelsDevModel>> {
	return buildModelsDevIndex(await modelgrep.get());
}

// Weighted blend, renormalized over present fields — a missing input dilutes
// only its own group, never zero-penalizes the whole score.
function blend(parts: [number, number | null | undefined][]): number | null {
	let weighted = 0;
	let present = 0;
	for (const [w, v] of parts) {
		if (v == null) continue;
		weighted += w * v;
		present += w;
	}
	return present === 0 ? null : weighted / present;
}

const frac = (v: number | null | undefined) => (v == null ? null : v / 100);

// AA Intelligence Index ceiling — current leader (Claude Fable 5) scores ~65,
// so /65 maps the index to ~0–100 with headroom and no clipping.
const INTELLIGENCE_MAX = 65;
// Fallback calibration. For the models that carry the index AND the raw benches
// (deduped overlap, n=29), we fit our heuristic (0–1) to the rescaled index via
// least-squares:
//   index100 ≈ SLOPE·heuristic + INTERCEPT
// Heuristic weights below + this line were jointly tuned against the index
// (R²=0.901, LOOCV-RMSE 6.55pt). Applying it to index-less models maps their
// heuristic onto the SAME scale as real index scores — a data-fit, not a
// guessed penalty. Refit if the catalog or weights change.
const FALLBACK_SLOPE = 120.6;
const FALLBACK_INTERCEPT = -10.6;
const clamp01to100 = (x: number) => Math.max(0, Math.min(100, x));

// Our coding/agentic-weighted heuristic from the raw evals (each used once —
// no double-counting with the index). Weights tuned against the AA index:
// agentic-heavy (.60) since tool-call matters most, coding (.30), reasoning a
// .10 tiebreaker. Sub-weights likewise fit — tau2 dominates the agentic group.
function heuristicScore(
	aa: NonNullable<NonNullable<ModelGrepModel["benchmarks"]>["artificial_analysis"]>,
): number | null {
	const coding = blend([
		[0.6, frac(aa.coding)],
		[0.4, aa.scicode],
	]);
	const agentic = blend([
		[0.7, aa.tau2],
		[0.3, frac(aa.agentic)],
	]);
	const reasoning = blend([
		[0.6, aa.gpqa],
		[0.4, aa.hle],
	]);
	return blend([
		[0.3, coding],
		[0.6, agentic],
		[0.1, reasoning],
	]);
}

// Model score 0–100. Prefer AA's Intelligence Index (authoritative 9-eval
// composite); when absent, map our heuristic onto the index scale via the
// fitted line. Null only when nothing is benchmarked.
function codingScore(bench: NonNullable<ModelGrepModel["benchmarks"]>): number | null {
	const aa = bench.artificial_analysis ?? {};
	if (aa.intelligence != null) {
		return Math.round((aa.intelligence / INTELLIGENCE_MAX) * 100);
	}
	const h = heuristicScore(aa);
	return h == null ? null : Math.round(clamp01to100(FALLBACK_SLOPE * h + FALLBACK_INTERCEPT));
}

function buildBenchIndex(): Map<string, BenchmarkEntry> {
	const index = new Map<string, BenchmarkEntry>();
	// BenchLM lookup table: normalized benchlm name → entry, indexed in source
	// order (highest score first when ties exist). Built once per call.
	const benchlmByNorm = new Map<string, BenchLMRawEntry[]>();
	for (const b of benchlm.getCached()) {
		const k = normalizeBenchlmName(b.model);
		if (!k) continue;
		const arr = benchlmByNorm.get(k) ?? [];
		arr.push(b);
		benchlmByNorm.set(k, arr);
	}

	// Rank by our computed score (desc); unscored sink to the bottom, holding
	// source order among themselves.
	const scored = modelgrep.getCached().map((g) => {
		const fromAA = g.benchmarks ? codingScore(g.benchmarks) : null;
		const score = fromAA ?? lookupBenchlmScore(g, benchlmByNorm);
		return { g, score };
	});
	scored.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
	scored.forEach(({ g, score }, i) => {
		const slug = slugOf(g.id);
		const entry: BenchmarkEntry = {
			rank: i + 1,
			model: g.name ?? g.id,
			creator: g.id.split("/")[0] ?? "",
			overallScore: score,
			inputPrice: g.pricing?.input ?? null,
			outputPrice: g.pricing?.output ?? null,
		};
		for (const k of [slug, normalize(slug)]) if (!index.has(k)) index.set(k, entry);
	});
	return index;
}

// Normalize a benchlm `model` field (e.g. "Claude Opus 4.8 (Max)") to a slug
// comparable to modelgrep ids (e.g. "claude-opus-4-8"). Drops parenthesized
// variants, lowercases, folds . _ space → -, strips leading/trailing dashes.
function normalizeBenchlmName(name: string): string {
	return name
		.replace(/\s*\([^)]*\)\s*/g, " ") // drop "(Max)", "(High)", etc.
		.toLowerCase()
		.replace(/[._\s]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

// Try to find a benchlm score for a modelgrep model. Match strategy:
//   1. exact normalized match of modelgrep slug
//   2. prefix overlap (claude-opus-4-8 ↔ claude-opus-4-8-thinking) — benchlm
//      may list a long-form name; prefer the shortest match on tie (base > variants)
//   3. if multiple benchlm entries match, return the highest score
function lookupBenchlmScore(
	g: ModelGrepModel,
	benchlmByNorm: Map<string, BenchLMRawEntry[]>,
): number | null {
	const slug = slugOf(g.id);
	const norm = normalize(slug);

	// Collect candidates: exact match + prefix matches (either side).
	const candidates: BenchLMRawEntry[] = [];
	const direct = benchlmByNorm.get(norm);
	if (direct) candidates.push(...direct);
	for (const [key, entries] of benchlmByNorm) {
		if (key === norm) continue;
		if (key.startsWith(norm) || norm.startsWith(key)) candidates.push(...entries);
	}
	if (candidates.length === 0) return null;

	// Best entry = highest overallScore. Sort by score desc, then by slug
	// length asc (prefer base name over suffix variants on a tie).
	const sorted = [...candidates].sort((a, b) => {
		const sa = a.overallScore ?? -Infinity;
		const sb = b.overallScore ?? -Infinity;
		if (sa !== sb) return sb - sa;
		return normalizeBenchlmName(a.model).length - normalizeBenchlmName(b.model).length;
	});
	const best = sorted[0];
	if (!best) return null;
	return best.overallScore ?? null;
}

/** Map a benchmark score (0–100) to a semantic color token. */
export function benchScoreColor(
	score: number | null | undefined,
): "success" | "warning" | "error" | "muted" {
	if (score == null) return "muted";
	if (score >= 80) return "success";
	if (score >= 60) return "warning";
	return "error";
}

export function lookupBenchmark(modelName: string): BenchmarkEntry | undefined {
	return findInIndex(modelName, buildBenchIndex());
}
