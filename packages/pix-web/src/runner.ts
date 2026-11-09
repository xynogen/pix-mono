import { getErrorMessage } from "@xynogen/pix-pretty/utils";
import {
	type FetchProvider,
	type FetchRequest,
	type FetchResponse,
	getFetchProvider,
	listFetchProviders,
} from "./providers.ts";

export interface ProviderAttemptError {
	provider: string;
	message: string;
}

export interface ProviderResult {
	provider: string;
	data: FetchResponse;
	errors: ProviderAttemptError[];
}

function candidates(requested?: string[]): FetchProvider[] {
	if (!requested?.length) {
		const available = listFetchProviders();
		const apiProviders = available.filter((provider) => provider.id !== "curl");
		return apiProviders.length > 0
			? apiProviders
			: available.filter((provider) => provider.id === "curl");
	}
	return requested.map((id) => {
		const provider = getFetchProvider(id);
		if (!provider) throw new Error(`Unknown fetch provider '${id}'`);
		return provider;
	});
}

export async function runFetch(
	request: FetchRequest,
	providers?: string[],
): Promise<ProviderResult> {
	const available = candidates(providers).filter((provider) => provider.isConfigured?.() ?? true);
	if (available.length === 0) throw new Error("No configured fetch provider");

	const errors: ProviderAttemptError[] = [];
	for (const provider of available) {
		request.signal?.throwIfAborted();
		try {
			return { provider: provider.id, data: await provider.fetch(request), errors };
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
		`fetch failed through ${errors.map((error) => error.provider).join(", ")}: ${errors
			.map((error) => error.message)
			.join(" | ")}`,
	);
}
