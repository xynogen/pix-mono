import { config, onConfigChange, type PixRuntime, pixRuntime } from "@xynogen/pix-runtime/config";
import { type VoiceConfig, voiceSection } from "@xynogen/pix-runtime/sections";

export type { VoiceConfig };

/** Normalize a typed language. Reject text that is not a language code. */
export function parseLanguage(value: string): string {
	const code = value.trim().toLowerCase();
	if (!code || code === "auto") return "auto";
	if (!/^[a-z]{2,3}(-[a-z0-9]{2,4})?$/.test(code))
		throw new Error(
			`"${value}" is not a language code. Use a code like en, id, or pt-br, or auto.`,
		);
	return code;
}

export function voiceModel(
	kind: "stt" | "tts",
	provider: { id: string; defaultModel: string },
): string {
	if (provider.id !== "9router") return provider.defaultModel;
	return kind === "stt" ? voiceConfig.sttNineRouterModel : voiceConfig.ttsNineRouterModel;
}

export function loadConfig(runtime: PixRuntime = pixRuntime()): VoiceConfig {
	return { ...runtime.get(voiceSection) };
}
export async function saveConfig(
	value: VoiceConfig,
	runtime: PixRuntime = pixRuntime(),
): Promise<void> {
	const change = await runtime.update(voiceSection, value);
	if (!change && JSON.stringify(runtime.get(voiceSection)) !== JSON.stringify(value))
		throw new Error("Failed to save voice settings to pix.json");
}

export const voiceConfig = { ...config(voiceSection) };
onConfigChange(() => Object.assign(voiceConfig, config(voiceSection)), { paths: ["voice.*"] });
