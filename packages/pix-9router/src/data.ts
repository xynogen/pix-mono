/**
 * data.ts — 9Router data layer
 *
 * Router-specific data only:
 *   - routerBaseUrl()  — resolved API base URL from env
 *   - routerModels     — DataSource<RouterModel[]>, cached 30m at ~/.cache/pi/9router.json
 *
 * models.dev + BenchLM data is provided by @xynogen/pix-data
 * (github.com/xynogen/pix-mono/tree/main/packages/pix-data), which shares the
 * same ~/.cache/pi/ cache directory. The DataSource implementation and the
 * models.dev index helpers live there — imported here, not duplicated.
 *
 * Environment:
 *   NINEROUTER_URL   — canonical base URL
 *   NINEROUTER_KEY   — canonical bearer token
 *   ROUTER_API_BASE / ROUTER_API_KEY — legacy aliases
 */

import { join } from "node:path";
import { CACHE_DIR, DataSource } from "@xynogen/pix-data";

export type {
	ModelGrepModel,
	ModelsDevApi,
	ModelsDevModel,
} from "@xynogen/pix-data";
// Re-export the shared models.dev API so existing consumers (provider.ts)
// can keep importing these names from "./data".
export {
	buildModelsDevIndex,
	fetchModelsDevIndex,
	lookupInIndex,
} from "@xynogen/pix-data";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RouterModel {
	id?: string;
	name?: string;
	context_window?: number;
	contextWindow?: number;
	max_tokens?: number;
	maxTokens?: number;
	owned_by?: string;
	/** 9router v1 API nests these inside capabilities */
	capabilities?: {
		contextWindow?: number;
		maxOutput?: number;
		[key: string]: unknown;
	};
}

interface RouterModelsResponse {
	data?: RouterModel[];
}

// ── Constants ──────────────────────────────────────────────────────────────────

/** Base URL from NINEROUTER_URL / ROUTER_API_BASE, with `/v1` appended. No default: an
 * unset URL means 9Router is not configured, so callers must not send a request. */
export function routerBaseUrl(): string | undefined {
	const configured = (process.env.NINEROUTER_URL || process.env.ROUTER_API_BASE)?.trim();
	if (!configured) return undefined;
	const base = configured.replace(/\/+$/, "");
	return base.endsWith("/v1") ? base : `${base}/v1`;
}

// ── Router models ──────────────────────────────────────────────────────────────

export const routerModels = new DataSource<RouterModel[]>({
	label: "9router",
	// registerProvider only refreshes once routerBaseUrl() is set.
	url: () => `${routerBaseUrl() ?? ""}/models`,
	headers: () => {
		const key = process.env.NINEROUTER_KEY || process.env.ROUTER_API_KEY;
		return key ? { Authorization: `Bearer ${key}` } : undefined;
	},
	skip: () => !(process.env.NINEROUTER_KEY || process.env.ROUTER_API_KEY),
	cachePath: join(CACHE_DIR, "9router.json"),
	ttlMs: 30 * 60 * 1000, // 30 minutes
	parse: (raw) => ((raw as RouterModelsResponse).data ?? []).filter((m) => Boolean(m.id)),
	parseCache: (data) =>
		((data as RouterModelsResponse | undefined)?.data ?? []).filter((m) => Boolean(m.id)),
	empty: [],
});

// ── models.dev index (read from pix-data shared cache) ────────────────────────
// fetchModelsDevIndex / buildModelsDevIndex / lookupInIndex are re-exported
// above directly from @xynogen/pix-data — they read the same shared
// ~/.cache/pi/models.json cache that pix-data warms.
