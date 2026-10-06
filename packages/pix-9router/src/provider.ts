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

import type { ClassifierResult, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ioTimeoutSignal } from "@xynogen/pix-runtime/io";
import type { ModelsDevModel, RouterModel } from "./data.ts";
import { fetchModelsDevIndex, lookupInIndex, routerBaseUrl, routerModels } from "./data.ts";

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

/** Known patterns for classifier models (System One protocol) */
export const CLASSIFIER_PATTERNS = [
	/\bjev\b/i,
	/\bspan\b/i,
	/\bsolar-decide\b/i,
	/\bclassifier\b/i,
];

export function isClassifierModel(model: RouterModel): boolean {
	const id = model.id ?? "";
	const name = model.name ?? "";
	const custom = (process.env.NINEROUTER_CLASSIFIER_MODELS || "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);

	if (custom.some((c) => id.toLowerCase().includes(c) || name.toLowerCase().includes(c))) {
		return true;
	}
	return CLASSIFIER_PATTERNS.some((p) => p.test(id) || p.test(name));
}

interface RouterModelsResponse {
	data?: RouterModel[];
}

const COMPAT = {
	supportsDeveloperRole: false,
	supportsUsageInStreaming: false,
	maxTokensField: "max_tokens",
} as const;

export function toModelConfig(devIndex: Map<string, ModelsDevModel>) {
	return (model: RouterModel) => {
		const id = model.id ?? "";
		const devModel = lookupInIndex(id, devIndex);

		if (isClassifierModel(model)) {
			return {
				type: "classifier" as const,
				id,
				name: getModelName(model, devModel),
				api: "typesafe-system-one",
				baseUrl: routerBaseUrl(),
				input: ["text" as const],
				cost: ZERO_COST,
				contextWindow: getContextWindow(model, devModel),
			};
		}

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
	// ponytail: Detect GPT-5/6 offline. Add metadata for new families instead of a network wait.
	return /reasoner|thinking|xhigh|high|max|pro|codex|opus|sonnet|(?:^|\/)gpt-[56](?:[.-]|$)/i.test(
		model.id ?? "",
	);
}

export default async function registerProvider(pi: ExtensionAPI): Promise<void> {
	const apiKey = process.env.NINEROUTER_KEY || process.env.ROUTER_API_KEY;

	if (!apiKey) {
		// Register shell provider so the name is known; no models available yet.
		pi.registerProvider("9router", {
			name: "9Router",
			baseUrl: routerBaseUrl(),
			apiKey: "$NINEROUTER_KEY",
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

export async function classifySystemOne(
	model: { id: string; baseUrl?: string; api?: string; provider?: string },
	context: { state: Record<string, unknown>; questions: Record<string, any> },
	apiKey: string,
	options?: { signal?: AbortSignal; headers?: Record<string, string> },
): Promise<ClassifierResult> {
	const output = {
		api: model.api ?? "typesafe-system-one",
		provider: model.provider ?? "9router",
		model: model.id,
		answers: {} as Record<string, any>,
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};

	try {
		const wireQuestions = Object.fromEntries(
			Object.entries(context.questions ?? {}).map(([key, q]) => [
				key,
				q.type === "bool" ? { ...q, type: "noul" } : q,
			]),
		);

		const base = (model.baseUrl || routerBaseUrl()).replace(/\/+$/, "");
		const url = `${base}/systemone`;
		const res = await fetch(url, {
			method: "POST",
			signal: ioTimeoutSignal(options?.signal),
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				"User-Agent": "pi-coding-agent",
				...(options?.headers ?? {}),
			},
			body: JSON.stringify({
				model: model.id,
				state: context.state,
				questions: wireQuestions,
			}),
		});

		if (!res.ok) {
			const errText = await res.text().catch(() => "");
			return {
				...output,
				stopReason: "error" as const,
				errorMessage: `9router /systemone returned ${res.status}: ${errText}`,
			};
		}

		const data = (await res.json()) as any;
		const answers: Record<string, any> = {};

		for (const [key, q] of Object.entries(context.questions ?? {})) {
			const ans = data?.answers?.[key];
			if (!ans) continue;
			if (q.type === "bool") {
				answers[key] = {
					type: "bool",
					probability: typeof ans.noul === "number" ? ans.noul : (ans.probability ?? 0),
				};
			} else if (q.type === "choice") {
				answers[key] = {
					type: "choice",
					choice: ans.choice,
					probabilities: ans.probabilities ?? {},
					confidence: ans.confidence ?? 0,
				};
			} else if (q.type === "score") {
				answers[key] = {
					type: "score",
					score: ans.score ?? 0,
					confidence: ans.confidence ?? 0,
				};
			} else {
				answers[key] = ans;
			}
		}

		const inputTokens = data?.usage?.input_tokens ?? 0;
		const outputTokens = data?.usage?.output_tokens ?? 0;

		return {
			...output,
			answers,
			usage: {
				input: inputTokens,
				output: outputTokens,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: inputTokens + outputTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
	} catch (error) {
		return {
			...output,
			stopReason: "error" as const,
			errorMessage: error instanceof Error ? error.message : String(error),
		};
	}
}

function providerConfig(
	apiKey: string,
	models: RouterModel[],
	devIndex: Map<string, ModelsDevModel>,
) {
	return {
		name: "9Router",
		baseUrl: routerBaseUrl(),
		apiKey,
		api: "openai-completions",
		headers: { "User-Agent": "pi-coding-agent" },
		models: models.map(toModelConfig(devIndex)),
		classifiers: {
			"typesafe-system-one": {
				classify: (
					model: Parameters<typeof classifySystemOne>[0],
					context: Parameters<typeof classifySystemOne>[1],
					options?: Parameters<typeof classifySystemOne>[3],
				) => classifySystemOne(model, context, apiKey, options),
			},
		},
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
