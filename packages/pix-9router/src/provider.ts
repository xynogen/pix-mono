/**
 * provider.ts — 9Router model provider
 *
 * Registers the "9router" provider in Pi, pulling live model list from the
 * router API. Falls back to an empty model list until both URL and key are set.
 *
 * Environment:
 *   ROUTER_API_BASE  — API base URL (required; no default)
 *   ROUTER_API_KEY   — bearer token (required for live model list)
 */

import {
	builtinProviders,
	type ClassifierApi,
	type ClassifierContext,
	type ClassifierModel,
	type ClassifierOptions,
	type ClassifierResult,
	formatUserAgent,
	type RefreshModelsContext,
} from "@xynogen/pix-data/ai";
import type { ExtensionAPI } from "@xynogen/pix-runtime/host";
import { ioTimeoutSignal } from "@xynogen/pix-runtime/io";
import { routerBaseUrl, routerKey } from "@xynogen/pix-runtime/nine-router";
import type { RouterModel } from "./data.ts";
import { routerImageModels, routerModels } from "./data.ts";
import { generateImages } from "./images.ts";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

const ZERO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
};

// Fallback when the router omits capabilities.vision.
const IMAGE_CAPABLE_PATTERNS = [/claude/i, /gpt-[456]/i, /kimi-k2/i, /hy3/i];

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

/** Router metadata is first-party; name patterns cover only fields the router omits. */
export function toModelConfig(model: RouterModel) {
	const id = model.id ?? "";
	if (isClassifierModel(model)) {
		return {
			type: "classifier" as const,
			id,
			name: getModelName(model),
			api: "typesafe-system-one",
			baseUrl: routerBaseUrl() ?? "",
			input: ["text" as const],
			cost: ZERO_COST,
			contextWindow: getContextWindow(model),
		};
	}
	return {
		id,
		name: getModelName(model),
		reasoning: getReasoning(model),
		input: getInputTypes(model),
		cost: ZERO_COST,
		contextWindow: getContextWindow(model),
		maxTokens: getMaxTokens(model),
		compat: COMPAT,
	};
}

export function toImageModelConfig(model: RouterModel) {
	return {
		type: "image" as const,
		id: model.id ?? "",
		name: getModelName(model),
		api: "9router-images",
		input: ["text" as const],
		output: ["image" as const],
		cost: ZERO_COST,
	};
}

export function getInputTypes(model: RouterModel): ("text" | "image")[] {
	const vision = model.capabilities?.vision;
	if (typeof vision === "boolean") return vision ? ["text", "image"] : ["text"];
	const id = model.id ?? "";
	if (IMAGE_CAPABLE_PATTERNS.some((p) => p.test(id))) return ["text", "image"];
	return ["text"];
}

export function getModelName(model: RouterModel): string {
	return model.name || model.id || "unknown";
}

export function getContextWindow(model: RouterModel): number {
	return (
		model.context_window ||
		model.contextWindow ||
		model.capabilities?.contextWindow ||
		DEFAULT_CONTEXT_WINDOW
	);
}

export function getMaxTokens(model: RouterModel): number {
	return model.max_tokens || model.maxTokens || model.capabilities?.maxOutput || DEFAULT_MAX_TOKENS;
}

export function getReasoning(model: RouterModel): boolean {
	// The router's own declaration wins; the pattern only covers models that omit it.
	if (typeof model.capabilities?.reasoning === "boolean") return model.capabilities.reasoning;
	// ponytail: Detect GPT-5/6 offline. Add metadata for new families instead of a network wait.
	return /reasoner|thinking|xhigh|high|max|pro|codex|opus|sonnet|(?:^|\/)gpt-[56](?:[.-]|$)/i.test(
		model.id ?? "",
	);
}

export default async function registerProvider(pi: ExtensionAPI): Promise<void> {
	const apiKey = routerKey();
	const baseUrl = routerBaseUrl();

	if (!apiKey || !baseUrl) {
		// Register shell provider so the name is known; no models available yet.
		pi.registerProvider("9router", {
			name: "9Router",
			baseUrl: baseUrl ?? "",
			apiKey: "$NINEROUTER_KEY",
			api: "openai-completions",
			models: [],
		});
		return;
	}

	// Upstream moved OpenAI `compat` settings from the provider level to the
	// per-model level (ProviderModelConfig.compat). Applied in toModelConfig.

	// Register from the router list cache only — startup must not block on network.
	const cached = routerModels.getCached();
	const cachedImages = routerImageModels.getCached();
	pi.registerProvider("9router", providerConfig(apiKey, baseUrl, cached, cachedImages));

	// Background router list refresh; re-registering after startup applies immediately.
	void Promise.all([routerModels.get(), routerImageModels.get()])
		.then(([models, images]) =>
			pi.registerProvider("9router", providerConfig(apiKey, baseUrl, models, images)),
		)
		.catch(() => {});
}

/**
 * 9router serves TypeSafe's System One protocol at `<base>/systemone`. Delegate to pi-ai's
 * built-in TypeSafe classifier (bool->noul, strict answers, retries, usage, client identity).
 * It dispatches on the model it is given, so 9router's baseUrl and id are kept.
 */
export async function classifySystemOne(
	model: ClassifierModel<ClassifierApi>,
	context: ClassifierContext,
	options?: ClassifierOptions,
): Promise<ClassifierResult> {
	const typesafe = (await builtinProviders()).find((provider) => provider.id === "typesafe");
	if (!typesafe?.classify) {
		return {
			api: model.api,
			provider: model.provider,
			model: model.id,
			answers: {},
			stopReason: "error",
			errorMessage: "pi-ai has no TypeSafe classifier; update Pi to 1.4 or later",
			timestamp: Date.now(),
		};
	}
	return typesafe.classify(model, context, options);
}

/**
 * 9router's OpenAI->Claude translator merges adjacent user messages (e.g. after an aborted
 * turn is dropped) by joining their text blocks with no separator: "/porc" + "fuck" reads
 * as "/porcfuck". End each user message that another user message follows with a blank line.
 */
export function separateUserTurns(messages: unknown[]): void {
	const isUser = (m: unknown): m is { content?: unknown } =>
		typeof m === "object" && m !== null && "role" in m && m.role === "user";
	for (const [i, msg] of messages.entries()) {
		if (!isUser(msg) || !isUser(messages[i + 1])) continue;
		if (typeof msg.content === "string") {
			msg.content = `${msg.content}\n\n`;
			continue;
		}
		if (!Array.isArray(msg.content)) continue;
		const text = msg.content
			.filter((part: { type?: unknown; text?: unknown }) => part?.type === "text")
			.pop();
		if (typeof text?.text === "string") text.text = `${text.text}\n\n`;
	}
}

export function providerConfig(
	apiKey: string,
	baseUrl: string,
	models: RouterModel[],
	imageModels: RouterModel[],
) {
	return {
		name: "9Router",
		baseUrl,
		apiKey,
		api: "openai-completions",
		models: [...models.map(toModelConfig), ...imageModels.map(toImageModelConfig)],
		images: { "9router-images": { generateImages } },
		classifiers: { "typesafe-system-one": { classify: classifySystemOne } },
		// Live fetch on /model refresh — bypasses the disk cache.
		// Pi calls refreshModels once per provider at every startup with
		// allowNetwork:false (awaited, no timeout) — never touch the network
		// there; serve the registered snapshot instead.
		async refreshModels({ signal, allowNetwork }: RefreshModelsContext) {
			if (!allowNetwork)
				return [...models.map(toModelConfig), ...imageModels.map(toImageModelConfig)];
			const [res, imageRes] = await Promise.all([
				fetch(`${baseUrl}/models`, {
					signal: ioTimeoutSignal(signal),
					headers: {
						Authorization: `Bearer ${apiKey}`,
						"User-Agent": formatUserAgent(),
					},
				}),
				fetch(`${baseUrl}/models/image`, {
					signal: ioTimeoutSignal(signal),
					headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": formatUserAgent() },
				}).catch(() => undefined),
			]);
			if (!res.ok) throw new Error(`9router /models: ${res.status}`);
			const raw = (await res.json()) as RouterModelsResponse;
			const imageRaw = imageRes?.ok
				? ((await imageRes.json()) as RouterModelsResponse)
				: { data: imageModels };
			const list = (raw.data ?? []).filter((m) => Boolean(m.id));
			return [
				...list.map(toModelConfig),
				...(imageRaw.data ?? []).filter((m) => Boolean(m.id)).map(toImageModelConfig),
			];
		},
	};
}
