import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { isKittyProtocolActive, setKittyProtocolActive } from "@earendil-works/pi-tui";
import * as audio from "@xynogen/pix-runtime/audio";
import { voiceSection } from "@xynogen/pix-runtime/sections";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";

// ponytail: intercept audio/discovery before import. Never open a device, save settings, or call a provider.
async function captureStt(onStage = (_stage: string) => {}) {
	const fixture = await withUiFixture({ hostTheme: true });
	const devices = [{ id: "default", label: "Fixture microphone with a long device label" }];
	const discovery = Promise.withResolvers<typeof devices>();
	let discovering: Promise<unknown> | undefined;
	const then = discovery.promise.then.bind(discovery.promise);
	spyOn(discovery.promise, "then").mockImplementation((...args) => {
		const completion = then(...args).finally(() => onStage("discovery-completed"));
		discovering = completion;
		return completion;
	});
	const scan = spyOn(audio, "listMicrophones")
		.mockResolvedValue(devices)
		.mockImplementationOnce(() => discovery.promise);
	const clock = spyOn(Date, "now").mockReturnValue(200_000_000);
	const kitty = isKittyProtocolActive();
	let level: ((db: number) => void) | undefined;
	const stop = spyOn(audio, "startRecording").mockImplementation((_device, options) => {
		level = options?.onLevel;
		return { path: "fixture-recording.wav", stop: async () => undefined };
	});
	const remove = spyOn(fs, "rm").mockResolvedValue(undefined);
	let restoreConfig = () => {};
	let shutdown: (() => Promise<void>) | undefined;
	let finish: (() => void) | undefined;
	let pending: Promise<void> | undefined;
	let restoreTranscript = () => {};
	let restoreCleaner = () => {};
	let finishCleanup: (() => void) | undefined;
	let dispose = () => {};
	const key = Symbol.for("@xynogen/pix-voice/providers");
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
	const errors: unknown[] = [];
	try {
		const { voiceConfig } = await import("./config.ts");
		const saved = { ...voiceConfig };
		restoreConfig = () => Object.assign(voiceConfig, saved);
		await fixture.runtime.update(voiceSection, {
			sttProvider: "absent",
			ttsProvider: "absent",
			sttCleanup: "off",
			sttShortcut: "alt+z",
			sttDevice: "default",
			sttLanguage: "auto",
			ttsPlay: true,
		});
		Object.assign(voiceConfig, fixture.runtime.get(voiceSection));
		Object.defineProperty(globalThis, key, {
			configurable: true,
			writable: true,
			value: { stt: new Map(), tts: new Map() },
		});
		const transcript = await import("./transcribe.ts");
		const ready = Promise.withResolvers<void>();
		const result = Promise.withResolvers<{ text: string; provider: string; model: string }>();
		finish = () =>
			result.resolve({ text: "um read the file", provider: "fixture", model: "fixture" });
		const cleanup = await import("./cleanup.ts");
		const cleaning = Promise.withResolvers<void>();
		const cleaned = Promise.withResolvers<import("./cleanup.ts").Cleanup>();
		finishCleanup = () =>
			cleaned.resolve({
				text: "Read the file",
				model: "fixture/selected-model",
				tokens: 12,
				applied: true,
			});
		const cleaner = spyOn(cleanup, "cleanTranscript").mockImplementation(() => {
			cleaning.resolve();
			return cleaned.promise;
		});
		restoreCleaner = () => cleaner.mockRestore();
		const transcribe = spyOn(transcript, "transcribeAudioFile").mockImplementation(() => {
			ready.resolve();
			return result.promise;
		});
		restoreTranscript = () => transcribe.mockRestore();
		const { default: registerStt, toggleDictation } = await import("./stt-command.ts");
		let component: { render(width: number): string[] } | undefined;
		let redraw!: () => void;
		let input!: (data: string) => unknown;
		let sessionStart!: (event: unknown, context: unknown) => void;
		let unlistened = false;
		const ctx = {
			hasUI: true,
			model: { provider: "fixture", id: "selected-model" },
			ui: {
				onTerminalInput: (callback: typeof input) => {
					input = callback;
					return () => {
						unlistened = true;
					};
				},
				setWidget: (
					_name: string,
					factory: ((tui: unknown, theme: unknown) => typeof component) | undefined,
				) => {
					component = factory?.(
						{ requestRender: () => redraw?.(), terminal: { columns: 120, rows: 40 } },
						roleTheme(),
					);
				},
			},
		};
		registerStt({
			registerCommand() {},
			registerShortcut() {},
			on: (event: string, handler: unknown) => {
				if (event === "session_shutdown") shutdown = handler as typeof shutdown;
				if (event === "session_start") sessionStart = handler as typeof sessionStart;
			},
		} as never);
		const output: string[] = [];
		const capture = (label: string) => {
			if (!component) throw new Error("Missing STT widget");
			// The private widget does not wrap. Its 32-cell device and key hints exceed 80 columns.
			output.push(label, ...captureRows(component, { width: 120, surface: "component" }));
		};
		// Observe the discovery redraw. The widget mounts before the scan resolves.
		const discovered = Promise.withResolvers<void>();
		redraw = () => discovered.resolve();
		await toggleDictation(ctx as never);
		onStage("discovery-pending");
		capture("stt:unknown-level");
		discovery.resolve(devices);
		await discovered.promise;
		capture("stt:device-label");
		level?.(-30);
		capture("stt:normal-level");
		level?.(-6);
		capture("stt:loud-level");
		pending = toggleDictation(ctx as never);
		await ready.promise;
		capture("stt:transcribing");
		voiceConfig.sttCleanup = "current";
		finish();
		await cleaning.promise;
		onStage("cleanup-pending");
		capture("stt:cleanup");
		await shutdown?.();
		finishCleanup();
		await pending;
		voiceConfig.sttCleanup = "off";
		sessionStart({}, ctx);
		setKittyProtocolActive(true);
		expect(input("\x1b[122;3u")).toEqual({ consume: true });
		capture("stt:hold");
		expect(input("\x1b[122;3:3u")).toEqual({ consume: true });
		capture("stt:tap");
		await shutdown?.();
		expect(unlistened).toBe(true);
		expect(remove.mock.calls.map(([path]) => path)).toEqual([
			"fixture-recording.wav",
			"fixture-recording.wav",
		]);
		const { default: registerVoice } = await import("./command.ts");
		let handler!: (args: string, context: unknown) => Promise<void>;
		registerVoice({
			registerCommand: (_name: string, command: { handler: typeof handler }) => {
				handler = command.handler;
			},
		} as never);
		await handler("", {
			model: { provider: "fixture", id: "selected-model" },
			modelRegistry: { getAvailable: () => [] },
			ui: {
				custom: async (
					factory: (
						tui: unknown,
						theme: unknown,
						kb: unknown,
						done: unknown,
					) => { render(width: number): string[]; dispose?(): void },
				) => {
					const modal = factory(
						{ requestRender() {}, terminal: { rows: 40 } },
						roleTheme(),
						{ matches: () => false },
						() => {},
					);
					dispose = () => modal.dispose?.();
					output.push("voice:settings", ...captureRows(modal, { width: 80, surface: "component" }));
					dispose();
					return null;
				},
			},
		});
		expect(scan.mock.calls).toHaveLength(3);
		expect(stop.mock.calls).toHaveLength(2);
		onStage("capture-completed");
		expect(output.join("\n")).toMatchSnapshot();
	} catch (error) {
		errors.push(error);
	} finally {
		try {
			try {
				// Settle the scan while the recording still owns its redraw callback.
				discovery.resolve(devices);
				await discovering;
			} finally {
				try {
					await shutdown?.();
				} finally {
					finish?.();
					finishCleanup?.();
					await pending;
				}
			}
			onStage("work-settled");
		} catch (error) {
			errors.push(error);
		} finally {
			try {
				for (const restore of [
					() => onStage("dependencies-restoring"),
					dispose,
					restoreTranscript,
					restoreCleaner,
					() => clock.mockRestore(),
					() => setKittyProtocolActive(kitty),
					() => remove.mockRestore(),
					() => stop.mockRestore(),
					() => scan.mockRestore(),
					() => {
						if (descriptor) Object.defineProperty(globalThis, key, descriptor);
						else Reflect.deleteProperty(globalThis, key);
					},
				]) {
					try {
						restore();
					} catch (error) {
						errors.push(error);
					}
				}
			} finally {
				try {
					await fixture.restore();
				} catch (error) {
					errors.push(error);
				} finally {
					try {
						restoreConfig();
						onStage("fixture-restored");
					} catch (error) {
						errors.push(error);
					}
				}
			}
		}
	}
	if (errors.length) throw errors[0];
}

test("captures actual STT widget and voice settings through safe runtime spies", async () => {
	await captureStt();
});

test("STT assertion failures settle fake discovery and cleanup before restoring dependencies", async () => {
	for (const stage of ["discovery-pending", "cleanup-pending", "capture-completed"]) {
		const clock = Date.now;
		const scan = audio.listMicrophones;
		const recording = audio.startRecording;
		const remove = fs.rm;
		const runtime = Reflect.get(globalThis, Symbol.for("@xynogen/pix-runtime"));
		const original = new Error(`Fixture assertion failed at ${stage}`);
		const stages: string[] = [];
		await expect(
			captureStt((current) => {
				stages.push(current);
				if (current === stage) throw original;
				if (current === "dependencies-restoring") throw new Error("Fixture restore failed");
			}),
		).rejects.toBe(original);
		expect(stages.slice(-3)).toEqual([
			"work-settled",
			"dependencies-restoring",
			"fixture-restored",
		]);
		expect(stages.indexOf("discovery-completed")).toBeLessThan(stages.indexOf("work-settled"));
		expect([Date.now, audio.listMicrophones, audio.startRecording, fs.rm]).toEqual([
			clock,
			scan,
			recording,
			remove,
		]);
		expect(Reflect.get(globalThis, Symbol.for("@xynogen/pix-runtime"))).toBe(runtime);
	}
});
