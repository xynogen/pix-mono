import { config, onConfigChange, type PixRuntime, pixRuntime } from "@xynogen/pix-runtime/config";
import { fetchSection, type WebConfig } from "@xynogen/pix-runtime/sections";

export type FetchConfig = WebConfig;
export function loadFetchConfig(runtime: PixRuntime = pixRuntime()): FetchConfig {
	return { ...runtime.get(fetchSection) };
}
export async function saveFetchConfig(
	value: FetchConfig,
	runtime: PixRuntime = pixRuntime(),
): Promise<void> {
	const change = await runtime.update(fetchSection, value);
	if (!change && JSON.stringify(runtime.get(fetchSection)) !== JSON.stringify(value))
		throw new Error("Failed to save fetch settings to pix.json");
}
export const fetchConfig = { ...config(fetchSection) };
onConfigChange(() => Object.assign(fetchConfig, config(fetchSection)), { paths: ["fetch.*"] });
