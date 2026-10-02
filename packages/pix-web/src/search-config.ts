import { config, onConfigChange, type PixRuntime, pixRuntime } from "@xynogen/pix-runtime/config";
import { searchSection, type WebConfig } from "@xynogen/pix-runtime/sections";

export type SearchConfig = WebConfig;
export function loadSearchConfig(runtime: PixRuntime = pixRuntime()): SearchConfig {
	return { ...runtime.get(searchSection) };
}
export async function saveSearchConfig(
	value: SearchConfig,
	runtime: PixRuntime = pixRuntime(),
): Promise<void> {
	const change = await runtime.update(searchSection, value);
	if (!change && JSON.stringify(runtime.get(searchSection)) !== JSON.stringify(value))
		throw new Error("Failed to save search settings to pix.json");
}
export const searchConfig = { ...config(searchSection) };
onConfigChange(() => Object.assign(searchConfig, config(searchSection)), { paths: ["search.*"] });
