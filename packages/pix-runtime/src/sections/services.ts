import { boolOr, defineSection, isObj, strArr } from "../schema.ts";

export interface WebConfig {
	provider: string;
	nineRouterModel: string;
}

const webDefaults: WebConfig = { provider: "auto", nineRouterModel: "exa" };
function parseWeb(raw: unknown): WebConfig {
	const item = isObj(raw) ? raw : {};
	return {
		provider: typeof item.provider === "string" ? item.provider : webDefaults.provider,
		nineRouterModel:
			typeof item.nineRouterModel === "string" ? item.nineRouterModel : webDefaults.nineRouterModel,
	};
}
export const fetchSection = defineSection({ key: "fetch", defaults: webDefaults, parse: parseWeb });
export const searchSection = defineSection({
	key: "search",
	defaults: webDefaults,
	parse: parseWeb,
});

const voiceDefaults = {
	sttProvider: "auto",
	ttsProvider: "auto",
	sttNineRouterModel: "dg/nova-3",
	ttsNineRouterModel: "edge-tts/en-US-AriaNeural",
	ttsPlay: true,
	sttDevice: "default",
	sttLanguage: "auto",
	sttShortcut: "ctrl+alt+z",
	sttCleanup: "off",
};
export type VoiceConfig = typeof voiceDefaults;
export const voiceSection = defineSection({
	key: "voice",
	defaults: voiceDefaults,
	parse(raw): VoiceConfig {
		const item = isObj(raw) ? raw : {};
		const result = { ...voiceDefaults };
		for (const key of Object.keys(result) as (keyof VoiceConfig)[]) {
			if (key === "ttsPlay") result.ttsPlay = boolOr(item.ttsPlay, true);
			else if (typeof item[key] === "string" && item[key].trim()) result[key] = item[key].trim();
		}
		result.sttLanguage = result.sttLanguage.toLowerCase();
		return result;
	},
});
export interface ToolboxConfig {
	disabledTools?: string[];
	loadedTools?: string[];
	enabledTools?: string[];
}
export const toolboxSection = defineSection<"toolbox", ToolboxConfig>({
	key: "toolbox",
	defaults: {},
	parse(raw) {
		const result: ToolboxConfig = {};
		if (isObj(raw)) {
			for (const key of ["disabledTools", "loadedTools", "enabledTools"] as const) {
				if (
					Array.isArray(raw[key]) &&
					raw[key].every((value: unknown) => typeof value === "string")
				)
					result[key] = strArr(raw[key]);
			}
		}
		return result;
	},
});
