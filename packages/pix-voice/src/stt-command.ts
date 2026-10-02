/**
 * Push-to-talk dictation into the prompt. Design from earendil-works/pi-voice (MIT).
 * Press the shortcut (or run /stt) to record. Press it again to stop, transcribe,
 * and add the text to the prompt editor. A live widget shows the input level.
 */

import { rm } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	isKeyRelease,
	isKeyRepeat,
	isKittyProtocolActive,
	type KeyId,
	matchesKey,
	parseKey,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { reportToolStatus } from "@xynogen/pix-pretty/tool-status";
import { showTransientMessage } from "@xynogen/pix-pretty/transient-error";
import { getErrorMessage, rule } from "@xynogen/pix-pretty/utils";
import { listMicrophones, type Recording, startRecording } from "@xynogen/pix-runtime/audio";
import { cleanTranscript, cleanupModel, hasSlip } from "./cleanup.ts";
import { voiceConfig } from "./config.ts";
import { transcribeAudioFile } from "./transcribe.ts";

const WIDGET = "voice-stt";
/** Device name column width. Pad and cut to it, so the level bar does not move. */
const DEVICE_WIDTH = 32;

export function levelBar(db: number | undefined, width = 16): string {
	if (db === undefined) return "░".repeat(width);
	const count = Math.max(0, Math.min(width, Math.round(((db + 60) / 60) * width)));
	return `${"█".repeat(count)}${"░".repeat(width - count)}`;
}

/**
 * Text to insert at the cursor. It adds a space when the prompt ends in a word.
 * ponytail: Pi gives no cursor position, so the check reads the prompt end. A
 * dictation into the middle of a word can lack a space. The fix needs a cursor API.
 */
export function dictationInsert(current: string, text: string): string {
	return current && !/\s$/.test(current) ? ` ${text}` : text;
}

/** A forgotten tap-mode recording stops here. 5 min of 16 kHz mono wav is about 9.6 MB. */
export const MAX_RECORDING_MS = 5 * 60_000;

type Phase =
	| {
			kind: "recording";
			recording: Recording;
			level?: number;
			/** Readable device name, the same as in the settings modal. */
			device?: string;
			limit: ReturnType<typeof setTimeout>;
	  }
	| { kind: "transcribing"; step: string; abort: AbortController };

let phase: Phase | undefined;
let redraw: (() => void) | undefined;
/** Press time of a recording the key started. A release after TAP_MS stops it. */
let heldSince: number | undefined;

/** A shorter press is a tap: the recording stays on until the next press. */
export const TAP_MS = 300;

/**
 * Classify raw input for the dictation key. A release still counts when the user
 * lets go of the modifier first, because the terminal then reports the bare key.
 */
export function keyEvent(
	data: string,
	shortcut: string,
): "press" | "repeat" | "release" | undefined {
	if (isKeyRelease(data)) {
		const key = parseKey(data);
		return key === shortcut || key === shortcut.split("+").at(-1) ? "release" : undefined;
	}
	if (!matchesKey(data, shortcut as KeyId)) return undefined;
	return isKeyRepeat(data) ? "repeat" : "press";
}

/** Esc cancels only while a dictation runs. Otherwise Pi keeps its own Esc. */
export function isCancelKey(data: string, active: boolean): boolean {
	return active && !isKeyRelease(data) && matchesKey(data, "escape");
}

/** Stop ffmpeg and delete the file. Nothing is transcribed. */
async function discardRecording(recording: Recording, limit: ReturnType<typeof setTimeout>) {
	clearTimeout(limit);
	await recording.stop().catch(() => undefined);
	await rm(recording.path, { force: true });
}

/** Esc during a dictation: drop it, and add nothing to the prompt. */
async function cancelDictation(ctx: ExtensionContext): Promise<void> {
	const current = phase;
	if (!current) return;
	phase = undefined;
	heldSince = undefined;
	redraw = undefined;
	ctx.ui.setWidget(WIDGET, undefined);
	showTransientMessage(ctx.ui, "Dictation cancelled. Nothing was added.", "info");
	// A transcription deletes its own file in its finally block.
	if (current.kind === "transcribing") current.abort.abort();
	else await discardRecording(current.recording, current.limit);
}

function message(error: unknown): string {
	return getErrorMessage(error);
}

function showWidget(ctx: ExtensionContext): void {
	ctx.ui.setWidget(
		WIDGET,
		(tui, theme) => {
			redraw = () => tui.requestRender();
			return {
				render() {
					const separator = rule(tui.terminal.columns, (glyphs) => theme.fg("borderMuted", glyphs));
					if (phase?.kind !== "recording")
						return [
							separator,
							`${theme.fg("warning", "…")} ${theme.fg("toolTitle", phase?.kind === "transcribing" ? phase.step : "transcribing")}${theme.fg("muted", " · esc cancel")}`,
						];
					const loud = phase.level !== undefined && phase.level > -12;
					const db = phase.level === undefined ? "" : ` ${phase.level.toFixed(0)} dB`;
					return [
						separator,
						`${theme.fg("error", "●")} ${theme.fg("toolTitle", "recording")} ${theme.fg("dim", truncateToWidth(phase.device ?? voiceConfig.sttDevice, DEVICE_WIDTH, "…", true))} ${theme.fg(loud ? "warning" : "success", levelBar(phase.level))}${theme.fg("muted", `${db} · ${heldSince === undefined ? `${voiceConfig.sttShortcut} stop` : "release to stop"} · esc cancel`)}`,
					];
				},
				invalidate() {},
			};
		},
		{ placement: "aboveEditor" },
	);
}

export async function toggleDictation(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI || phase?.kind === "transcribing") return;
	if (!phase) {
		try {
			const recording = startRecording(voiceConfig.sttDevice, {
				onLevel: (db) => {
					if (phase?.kind === "recording") phase.level = db;
					redraw?.();
				},
				onExit: (error) => {
					// ffmpeg died on its own. Clear the widget, so it does not show "recording".
					if (phase?.kind !== "recording" || phase.recording !== recording) return;
					clearTimeout(phase.limit);
					phase = undefined;
					heldSince = undefined;
					redraw = undefined;
					void rm(recording.path, { force: true });
					try {
						ctx.ui.setWidget(WIDGET, undefined);
						showTransientMessage(ctx.ui, `Recording failed: ${message(error)}`, "error");
					} catch {
						// The session ended. There is no UI to update.
					}
				},
				onStatus: reportToolStatus(ctx.ui),
			});
			const limit = setTimeout(() => {
				if (phase?.kind !== "recording" || phase.recording !== recording) return;
				heldSince = undefined;
				showTransientMessage(
					ctx.ui,
					"Dictation stopped at the 5 min limit. Transcribing.",
					"warning",
				);
				void toggleDictation(ctx);
			}, MAX_RECORDING_MS);
			phase = { kind: "recording", recording, limit };
			showWidget(ctx);
			// The raw id shows until the device scan answers. On a failure the id stays.
			void listMicrophones()
				.then((devices) => {
					if (phase?.kind !== "recording" || phase.recording !== recording) return;
					phase.device = devices.find((d) => d.id === voiceConfig.sttDevice)?.label;
					redraw?.();
				})
				.catch(() => undefined);
		} catch (error) {
			showTransientMessage(ctx.ui, message(error), "error");
		}
		return;
	}

	const { recording, limit } = phase;
	clearTimeout(limit);
	const abort = new AbortController();
	const { signal } = abort;
	phase = { kind: "transcribing", step: "transcribing", abort };
	redraw?.();
	try {
		await recording.stop();
		const result = await transcribeAudioFile(recording.path, signal);
		signal.throwIfAborted();
		let text = result.text.trim();
		let model = `${result.provider}/${result.model} · ${result.language ?? "auto"}`;
		if (!text) {
			showTransientMessage(ctx.ui, `No speech found · ${model}`, "warning");
			return;
		}
		let level: "info" | "warning" = "info";
		try {
			const cleaner = cleanupModel(voiceConfig.sttCleanup, ctx);
			if (cleaner && !hasSlip(text)) model += " · cleanup skipped, no slip found";
			else if (cleaner) {
				phase = {
					kind: "transcribing",
					step: `cleaning up · ${cleaner.provider}/${cleaner.id}`,
					abort,
				};
				redraw?.();
				const cleanup = await cleanTranscript(text, cleaner, ctx, signal);
				text = cleanup.text;
				model += cleanup.applied
					? ` · cleaned by ${cleanup.model} (${cleanup.tokens} tok)`
					: ` · cleanup by ${cleanup.model} rejected, raw text kept`;
				if (!cleanup.applied) level = "warning";
			}
		} catch (error) {
			if (signal.aborted) throw error;
			// Keep the dictation. A cleanup failure must not lose what the user said.
			model += ` · cleanup failed, raw text kept: ${message(error)}`;
			level = "warning";
		}
		// Esc can cancel while a provider ignores the signal. Add nothing then.
		signal.throwIfAborted();
		// A paste goes in at the cursor and keeps the editor undo history.
		ctx.ui.pasteToEditor(dictationInsert(ctx.ui.getEditorText(), text));
		showTransientMessage(ctx.ui, `Dictation added to the prompt · ${model}`, level);
	} catch (error) {
		// An abort is Esc or the session end. Both already cleared the UI.
		if (!signal.aborted)
			showTransientMessage(ctx.ui, `Dictation failed: ${message(error)}`, "error");
	} finally {
		// The recording is the user's voice. Delete it first: a stale ctx can throw below.
		await rm(recording.path, { force: true });
		// After an abort, a new dictation can own phase and the widget. Leave them.
		if (!signal.aborted) {
			phase = undefined;
			redraw = undefined;
			ctx.ui.setWidget(WIDGET, undefined);
		}
	}
}

/**
 * Raw input listener for hold-to-talk. Pi does not pass key releases to shortcuts,
 * so the key is read here. Hold: record until release. Tap: record until the next press.
 * Without the Kitty keyboard protocol there is no release, so every press toggles.
 */
function listen(ctx: ExtensionContext): () => void {
	return ctx.ui.onTerminalInput((data) => {
		if (isCancelKey(data, phase !== undefined)) {
			void cancelDictation(ctx);
			return { consume: true };
		}
		const event = keyEvent(data, voiceConfig.sttShortcut);
		if (!event) return undefined;
		if (event === "repeat") return { consume: true };
		if (event === "release") {
			if (heldSince === undefined) return undefined;
			const held = Date.now() - heldSince;
			heldSince = undefined;
			if (held >= TAP_MS) void toggleDictation(ctx);
			else redraw?.();
			return { consume: true };
		}
		const starting = !phase;
		void toggleDictation(ctx);
		heldSince = starting && isKittyProtocolActive() ? Date.now() : undefined;
		return { consume: true };
	});
}

export default function registerSttCommand(pi: ExtensionAPI): void {
	// Fallback only: the terminal listener consumes the key first when it runs.
	pi.registerShortcut(voiceConfig.sttShortcut as KeyId, {
		description: "Hold to dictate into the prompt, or tap to start and stop",
		handler: toggleDictation,
	});
	let unlisten: (() => void) | undefined;
	pi.on("session_start", (_event, ctx) => {
		unlisten?.();
		unlisten = ctx.hasUI ? listen(ctx) : undefined;
	});
	pi.registerCommand("stt", {
		description: `Start or stop voice dictation into the prompt (same as ${voiceConfig.sttShortcut})`,
		handler: (_args, ctx) => toggleDictation(ctx),
	});
	pi.on("session_shutdown", async () => {
		unlisten?.();
		unlisten = undefined;
		heldSince = undefined;
		if (phase?.kind === "transcribing") {
			// The transcription owns the file. Its finally block deletes it.
			phase.abort.abort();
			phase = undefined;
			return;
		}
		if (phase?.kind !== "recording") return;
		const { recording, limit } = phase;
		phase = undefined;
		await discardRecording(recording, limit);
	});
}
