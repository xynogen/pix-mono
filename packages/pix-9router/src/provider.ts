/**
 * provider.ts — 9Router model provider
 *
 * Registers the "9router" provider in Pi, pulling live model list from the
 * router API. Falls back to an empty model list if ROUTER_API_KEY is unset.
 *
 * Environment:
 *   ROUTER_API_BASE  — override API base URL (default: https://9router.example.com/v1)
 *   ROUTER_API_KEY   — bearer token (required for live model list)
 */

import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ioTimeoutSignal } from "@xynogen/pix-runtime/io";
import type { ModelsDevModel, RouterModel } from "./data.js";
import { fetchModelsDevIndex, lookupInIndex, routerBaseUrl, routerModels } from "./data.js";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

const ZERO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
};

// Fallback pattern-based detection if models.dev lookup fails
const IMAGE_CAPABLE_PATTERNS = [/claude/i, /gpt-5/i, /gpt-4/i, /kimi-k2/i, /hy3/i];

interface RouterModelsResponse {
	data?: RouterModel[];
}

const COMPAT = {
	supportsDeveloperRole: false,
	supportsUsageInStreaming: false,
	maxTokensField: "max_tokens",
} as const;

function toModelConfig(devIndex: Map<string, ModelsDevModel>) {
	return (model: RouterModel) => {
		const id = model.id ?? "";
		const devModel = lookupInIndex(id, devIndex);
		return {
			id,
			name: getModelName(model, devModel),
			reasoning: getReasoning(model, devModel),
			input: getInputTypes(model, devModel),
			cost: ZERO_COST,
			contextWindow: getContextWindow(model, devModel),
			maxTokens: getMaxTokens(model, devModel),
			compat: COMPAT,
		};
	};
}

export function getInputTypes(model: RouterModel, devModel?: ModelsDevModel): ("text" | "image")[] {
	if (devModel?.modalities?.input) {
		const inputs = devModel.modalities.input.filter(
			(i): i is "text" | "image" => i === "text" || i === "image",
		);
		if (inputs.length > 0) return inputs;
	}
	const id = model.id ?? "";
	if (IMAGE_CAPABLE_PATTERNS.some((p) => p.test(id))) return ["text", "image"];
	return ["text"];
}

export function getModelName(model: RouterModel, devModel?: ModelsDevModel): string {
	return model.name || devModel?.name || model.id || "unknown";
}

export function getContextWindow(model: RouterModel, devModel?: ModelsDevModel): number {
	return (
		model.context_window ||
		model.contextWindow ||
		model.capabilities?.contextWindow ||
		devModel?.limit?.context ||
		DEFAULT_CONTEXT_WINDOW
	);
}

export function getMaxTokens(model: RouterModel, devModel?: ModelsDevModel): number {
	return (
		model.max_tokens ||
		model.maxTokens ||
		model.capabilities?.maxOutput ||
		devModel?.limit?.output ||
		DEFAULT_MAX_TOKENS
	);
}

export function getReasoning(model: RouterModel, devModel?: ModelsDevModel): boolean {
	if (typeof devModel?.reasoning === "boolean") return devModel.reasoning;
	return /reasoner|thinking|xhigh|high|max|pro|codex|opus|sonnet/i.test(model.id ?? "");
}

export default async function registerProvider(pi: ExtensionAPI): Promise<void> {
	const apiKey = process.env.ROUTER_API_KEY;

	if (!apiKey) {
		// Register shell provider so the name is known; no models available yet.
		pi.registerProvider("9router", {
			name: "9Router",
			baseUrl: routerBaseUrl(),
			apiKey: "$ROUTER_API_KEY",
			api: "openai-completions",
			models: [],
		});
		return;
	}

	// Upstream moved OpenAI `compat` settings from the provider level to the
	// per-model level (ProviderModelConfig.compat). Applied in toModelConfig.

	// Register from disk cache only — startup must not block on network.
	const cached = routerModels.getCached();
	pi.registerProvider("9router", providerConfig(apiKey, cached, new Map()));

	// Background refresh; re-registering after startup applies immediately.
	void Promise.all([
		routerModels.get(),
		fetchModelsDevIndex().catch(() => new Map<string, ModelsDevModel>()),
	])
		.then(([models, devIndex]) =>
			pi.registerProvider("9router", providerConfig(apiKey, models, devIndex)),
		)
		.catch(() => {});
}

function providerConfig(
	apiKey: string,
	models: RouterModel[],
	devIndex: Map<string, ModelsDevModel>,
) {
	return {
		name: "9Router",
		baseUrl: routerBaseUrl(),
		apiKey: "$ROUTER_API_KEY",
		api: "openai-completions",
		headers: { "User-Agent": "pi-coding-agent" },
		models: models.map(toModelConfig(devIndex)),
		// Live fetch on /model refresh — bypasses the disk cache.
		// Pi calls refreshModels once per provider at every startup with
		// allowNetwork:false (awaited, no timeout) — never touch the network
		// there; serve the registered snapshot instead.
		async refreshModels({ signal, allowNetwork }: RefreshModelsContext) {
			if (!allowNetwork) return models.map(toModelConfig(devIndex));
			const res = await fetch(`${routerBaseUrl()}/models`, {
				signal: ioTimeoutSignal(signal),
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"User-Agent": "pi-coding-agent",
				},
			});
			if (!res.ok) throw new Error(`9router /models: ${res.status}`);
			const raw = (await res.json()) as RouterModelsResponse;
			const list = (raw.data ?? []).filter((m) => Boolean(m.id));
			const fresh = await fetchModelsDevIndex().catch(() => new Map<string, ModelsDevModel>());
			return list.map(toModelConfig(fresh));
		},
	};
}
