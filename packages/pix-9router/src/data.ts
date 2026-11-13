/**
 * data.ts — 9Router data layer
 *
 * Router-specific data only:
 *   - routerModels     — DataSource<RouterModel[]>, cached 30m at ~/.cache/pi/9router.json
 *
 * The router's /models response carries all provider metadata (capabilities, limits).
 * No external catalog is consulted, so registration never waits on another service.
 *
 * Environment:
 *   NINEROUTER_URL   — canonical base URL
 *   NINEROUTER_KEY   — canonical bearer token
 *   ROUTER_API_BASE / ROUTER_API_KEY — legacy aliases
 */

import { join } from "node:path";
import { CACHE_DIR, DataSource } from "@xynogen/pix-data";
import { routerBaseUrl, routerKey } from "@xynogen/pix-runtime/nine-router";

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
		reasoning?: boolean;
		vision?: boolean;
		[key: string]: unknown;
	};
}

interface RouterModelsResponse {
	data?: RouterModel[];
}

// ── Router models ──────────────────────────────────────────────────────────────

export const routerModels = new DataSource<RouterModel[]>({
	label: "9router",
	// registerProvider only refreshes once routerBaseUrl() is set.
	url: () => `${routerBaseUrl() ?? ""}/models`,
	headers: () => {
		const key = routerKey();
		return key ? { Authorization: `Bearer ${key}` } : undefined;
	},
	skip: () => !routerKey(),
	cachePath: join(CACHE_DIR, "9router.json"),
	ttlMs: 30 * 60 * 1000, // 30 minutes
	parse: (raw) => ((raw as RouterModelsResponse).data ?? []).filter((m) => Boolean(m.id)),
	parseCache: (data) =>
		((data as RouterModelsResponse | undefined)?.data ?? []).filter((m) => Boolean(m.id)),
	empty: [],
});
