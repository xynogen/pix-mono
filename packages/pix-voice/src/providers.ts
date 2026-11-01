/** Provider registries for speech-to-text and text-to-speech. */

export interface TranscribeRequest {
	file: string;
	model: string;
	language?: string;
	signal?: AbortSignal;
}

export interface SpeechRequest {
	input: string;
	model: string;
	/** Requested format. A provider may return another format; it reports the real one. */
	format: string;
	signal?: AbortSignal;
}

export interface SpeechAudio {
	audio: Uint8Array;
	format: string;
}

interface BaseProvider {
	id: string;
	defaultModel: string;
	/** Env var names this provider reads. Shown in /pix → Voice. */
	env?: string[];
	isConfigured?: () => boolean;
}

export interface SttProvider extends BaseProvider {
	transcribe: (request: TranscribeRequest) => Promise<string>;
}

export interface TtsProvider extends BaseProvider {
	synthesize: (request: SpeechRequest) => Promise<SpeechAudio>;
}

export type VoiceKind = "stt" | "tts";
type ProviderOf<K extends VoiceKind> = K extends "stt" ? SttProvider : TtsProvider;

const REGISTRY = Symbol.for("@xynogen/pix-voice/providers");

function registry<K extends VoiceKind>(kind: K): Map<string, ProviderOf<K>> {
	const root = globalThis as typeof globalThis & {
		[REGISTRY]?: { stt: Map<string, SttProvider>; tts: Map<string, TtsProvider> };
	};
	root[REGISTRY] ??= { stt: new Map(), tts: new Map() };
	return root[REGISTRY][kind] as Map<string, ProviderOf<K>>;
}

export function registerProvider<K extends VoiceKind>(kind: K, provider: ProviderOf<K>): void {
	if (!provider.id.trim()) throw new Error(`A ${kind} provider needs an id`);
	registry(kind).set(provider.id, provider);
}

export function isConfigured(provider: BaseProvider): boolean {
	return provider.isConfigured?.() ?? true;
}

export function listProviders<K extends VoiceKind>(kind: K): ProviderOf<K>[] {
	return [...registry(kind).values()];
}

/**
 * Resolve the provider for one call. "auto" takes the first configured provider
 * in registration order. There is no silent fallback to a second provider: the
 * tool result names the provider that ran.
 */
export function resolveProvider<K extends VoiceKind>(kind: K, id: string): ProviderOf<K> {
	if (id !== "auto") {
		const provider = registry(kind).get(id);
		if (!provider) throw new Error(`Unknown ${kind} provider '${id}'`);
		if (!isConfigured(provider))
			throw new Error(
				`${kind} provider '${id}' is not configured: set ${provider.env?.join(", ")}`,
			);
		return provider;
	}
	const provider = listProviders(kind).find(isConfigured);
	if (!provider)
		throw new Error(`No configured ${kind} provider. Run /pix → Voice to see the options.`);
	return provider;
}
