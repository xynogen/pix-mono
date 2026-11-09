import { getErrorMessage } from "@xynogen/pix-pretty/utils";
import {
	getSearchProvider,
	listSearchProviders,
	type SearchProvider,
	type SearchRequest,
	type SearchResultItem,
} from "./search-providers.ts";

export interface SearchAttemptError {
	provider: string;
	message: string;
}

export interface SearchProviderResult {
	provider: string;
	data: SearchResultItem[];
	errors: SearchAttemptError[];
}

function candidates(requested?: string[]): SearchProvider[] {
	if (!requested?.length) {
		const available = listSearchProviders();
		const keyedProviders = available.filter((provider) => provider.id !== "searxng");
		return keyedProviders.length > 0
			? keyedProviders
			: available.filter((provider) => provider.id === "searxng");
	}
	return requested.map((id) => {
		const provider = getSearchProvider(id);
		if (!provider) throw new Error(`Unknown search provider '${id}'`);
		return provider;
	});
}

export async function runSearch(
	request: SearchRequest,
	providers?: string[],
): Promise<SearchProviderResult> {
	const available = candidates(providers).filter((provider) => provider.isConfigured?.() ?? true);
	if (available.length === 0) throw new Error("No configured search provider");

	const errors: SearchAttemptError[] = [];
	for (const provider of available) {
		request.signal?.throwIfAborted();
		try {
			return { provider: provider.id, data: await provider.search(request), errors };
		} catch (error) {
			request.signal?.throwIfAborted();
			if (error instanceof DOMException && error.name === "AbortError") throw error;
			errors.push({
				provider: provider.id,
				message: getErrorMessage(error),
			});
		}
	}

	throw new Error(
		`search failed through ${errors.map((error) => error.provider).join(", ")}: ${errors
			.map((error) => error.message)
			.join(" | ")}`,
	);
}
