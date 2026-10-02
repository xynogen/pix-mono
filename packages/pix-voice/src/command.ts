import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import {
	type SettingsRow,
	showProviderPicker,
	showSettingsPicker,
} from "@xynogen/pix-pretty/provider-picker";
import { reportToolStatus } from "@xynogen/pix-pretty/tool-status";
import { showTransientMessage } from "@xynogen/pix-pretty/transient-error";
import { listMicrophones, type Microphone, startRecording } from "@xynogen/pix-runtime/audio";
import { cleanupModel } from "./cleanup.ts";
import { parseLanguage, saveConfig, voiceConfig } from "./config.ts";
import { isConfigured, listProviders, type VoiceKind } from "./providers.ts";
import { levelBar } from "./stt-command.ts";

const NINE_ROUTER = "9router";
const ROUTER_ALIASES = { NINEROUTER_URL: "ROUTER_API_BASE", NINEROUTER_KEY: "ROUTER_API_KEY" };
const SECTION: Record<VoiceKind, string> = { stt: "Speech to text", tts: "Text to speech" };

/** Common dictation languages. Any other code is still one "type a value…" away. */
const LANGUAGES = [
	{ value: "auto", hint: "detect" },
	...Object.entries({
		en: "English",
		id: "Indonesian",
		ms: "Malay",
		zh: "Chinese",
		ja: "Japanese",
		ko: "Korean",
		hi: "Hindi",
		ar: "Arabic",
		es: "Spanish",
		fr: "French",
		de: "German",
		pt: "Portuguese",
		it: "Italian",
		nl: "Dutch",
		ru: "Russian",
		tr: "Turkish",
		vi: "Vietnamese",
		th: "Thai",
		fil: "Filipino",
		pl: "Polish",
	}).map(([value, hint]) => ({ value, hint })),
];

function selectedProvider(kind: VoiceKind) {
	const selected = kind === "stt" ? voiceConfig.sttProvider : voiceConfig.ttsProvider;
	const providers = listProviders(kind);
	return selected === "auto"
		? providers.find(isConfigured)
		: providers.find((item) => item.id === selected);
}

/** Provider value plus its status color: connected, or which variables are missing. */
function providerValue(kind: VoiceKind): Pick<SettingsRow, "value" | "tone"> {
	const id = kind === "stt" ? voiceConfig.sttProvider : voiceConfig.ttsProvider;
	const provider = selectedProvider(kind);
	if (!provider) return { value: `${id} · not configured`, tone: "warning" };
	const label = id === "auto" ? `auto → ${provider.id}` : id;
	return isConfigured(provider)
		? { value: `${label} · connected`, tone: "success" }
		: { value: `${label} · set ${provider.env?.join(", ")}`, tone: "warning" };
}

function nineRouterModel(kind: VoiceKind): string {
	return kind === "stt" ? voiceConfig.sttNineRouterModel : voiceConfig.ttsNineRouterModel;
}

async function saveNineRouterModel(kind: VoiceKind, value: string | undefined): Promise<void> {
	const model = value?.trim();
	if (!model) return;
	if (kind === "stt") voiceConfig.sttNineRouterModel = model;
	else voiceConfig.ttsNineRouterModel = model;
	await saveConfig(voiceConfig);
}

/** Color-coded provider tree, the same view as /web. Only 9router has a model field. */
async function editProvider(ctx: ExtensionContext, kind: VoiceKind): Promise<void> {
	while (true) {
		const action = await showProviderPicker(ctx.ui, {
			title: `${icon("settings")} ${SECTION[kind]}`,
			subtitle: `Default ${kind.toUpperCase()} provider · shell variables · provider settings`,
			rows: [
				{ id: "auto", configured: true, env: [] },
				...listProviders(kind).map((provider) => ({
					id: provider.id,
					configured: isConfigured(provider),
					env: provider.env ?? [],
					model: provider.id === NINE_ROUTER ? nineRouterModel(kind) : undefined,
				})),
			],
			current: kind === "stt" ? voiceConfig.sttProvider : voiceConfig.ttsProvider,
			envAliases: ROUTER_ALIASES,
		});
		if (!action) return;
		if (action.kind === "model") {
			await saveNineRouterModel(kind, action.value);
			continue;
		}
		if (kind === "stt") voiceConfig.sttProvider = action.id;
		else voiceConfig.ttsProvider = action.id;
		await saveConfig(voiceConfig);
		return;
	}
}

/** Cleanup choices: off, the session model, then each model with a key. */
function cleanupChoices(ctx: ExtensionContext) {
	return [
		{ value: "off", hint: "raw transcript" },
		{ value: "current", hint: ctx.model ? `session model · ${ctx.model.id}` : "session model" },
		...ctx.modelRegistry
			.getAvailable()
			.map((model) => ({ value: `${model.provider}/${model.id}`, hint: model.name })),
	];
}

function settingsRows(
	testing: boolean,
	mics: Microphone[],
	cleanup: SettingsRow["choices"],
): SettingsRow[] {
	const row = (kind: VoiceKind, key: string, label: string, value: string, extra = {}) => ({
		key: `${kind}:${key}`,
		section: SECTION[kind],
		label,
		value,
		...extra,
	});
	const model = (kind: VoiceKind) =>
		row(kind, "model", "9router model", nineRouterModel(kind), {
			tone: selectedProvider(kind)?.id === NINE_ROUTER ? "success" : "muted",
			editable: true,
		});
	return [
		row("stt", "provider", "provider", "", providerValue("stt")),
		model("stt"),
		row(
			"stt",
			"device",
			"microphone",
			// A saved input that is unplugged still shows by its id.
			mics.find((mic) => mic.id === voiceConfig.sttDevice)?.label ?? voiceConfig.sttDevice,
			{ choices: mics.map((mic) => ({ value: mic.id, label: mic.label })) },
		),
		row("stt", "test", "test microphone", testing ? "on · enter stop" : "off · enter start", {
			tone: testing ? "warning" : "muted",
		}),
		row("stt", "language", "language", voiceConfig.sttLanguage, {
			tone: voiceConfig.sttLanguage === "auto" ? "muted" : "success",
			editable: true,
			choices: LANGUAGES,
		}),
		row("stt", "cleanup", "cleanup model", voiceConfig.sttCleanup, {
			tone: voiceConfig.sttCleanup === "off" ? "muted" : "success",
			editable: true,
			choices: cleanup,
		}),
		row("stt", "shortcut", "dictation key", voiceConfig.sttShortcut, { editable: true }),
		row("tts", "provider", "provider", "", providerValue("tts")),
		model("tts"),
		row("tts", "play", "play after generation", voiceConfig.ttsPlay ? "on" : "off", {
			tone: voiceConfig.ttsPlay ? "success" : "muted",
		}),
	];
}

export default function registerVoiceCommand(pi: ExtensionAPI): void {
	pi.registerCommand("voice", {
		description:
			"Set the speech-to-text and text-to-speech providers, 9Router models, microphone, and playback",
		handler: async (_args, ctx) => {
			let cursor = 0;
			// Read once per /voice. The device scan is too slow for each render.
			const mics = await listMicrophones().catch(() => [
				{ id: "default", label: "System default" },
			]);
			const cleanup = cleanupChoices(ctx);
			let stopMeter: (() => void) | undefined;
			let level: number | undefined;
			let redraw: (() => void) | undefined;
			const stopTest = () => {
				stopMeter?.();
				stopMeter = undefined;
				level = undefined;
			};
			const startTest = () => {
				const meter = startRecording(voiceConfig.sttDevice, {
					meterOnly: true,
					onLevel: (db) => {
						level = db;
						redraw?.();
					},
					onStatus: reportToolStatus(ctx.ui),
				});
				stopMeter = () => void meter.stop();
			};
			try {
				while (true) {
					// The modal stays open for every setting. It closes only to open the provider tree.
					const action = await showSettingsPicker(ctx.ui, {
						title: `${icon("settings")} Voice Settings`,
						rows: () => settingsRows(Boolean(stopMeter), mics, cleanup),
						selected: cursor,
						onMount: (fn) => {
							redraw = fn;
							return () => {
								redraw = undefined;
							};
						},
						status: () =>
							stopMeter
								? [
										`  ${levelBar(level, 24)} ${level === undefined ? "waiting for input…" : `${level.toFixed(1)} dB`}`,
									]
								: [],
						onAction: async ({ key, value }) => {
							const [kind, field] = key.split(":") as [VoiceKind, string];
							if (field === "provider") return "close";
							if (field === "model") await saveNineRouterModel(kind, value);
							else if (field === "test") {
								if (stopMeter) stopTest();
								else startTest();
							} else if (field === "device" && value) {
								voiceConfig.sttDevice = value;
								await saveConfig(voiceConfig);
								// Keep the test on the new input.
								if (stopMeter) {
									stopTest();
									startTest();
								}
							} else if (field === "language" && value) {
								// Throws on a bad code. The modal shows the error and stays open.
								voiceConfig.sttLanguage = parseLanguage(value);
								await saveConfig(voiceConfig);
							} else if (field === "cleanup" && value) {
								// Throws on an unknown model. The modal shows the error and stays open.
								cleanupModel(value.trim(), ctx);
								voiceConfig.sttCleanup = value.trim();
								await saveConfig(voiceConfig);
							} else if (field === "shortcut" && value) {
								voiceConfig.sttShortcut = value;
								await saveConfig(voiceConfig);
								showTransientMessage(
									ctx.ui,
									`Dictation key: ${value}. Restart Pi to use it.`,
									"info",
								);
							} else if (field === "play") {
								voiceConfig.ttsPlay = !voiceConfig.ttsPlay;
								await saveConfig(voiceConfig);
							}
							return undefined;
						},
					});
					stopTest();
					if (!action) return;
					cursor = settingsRows(false, mics, cleanup).findIndex((row) => row.key === action.key);
					await editProvider(ctx, action.key.split(":")[0] as VoiceKind);
				}
			} finally {
				stopTest();
			}
		},
	});
}
