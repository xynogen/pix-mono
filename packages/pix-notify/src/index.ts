import { existsSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import type {
	EventBus,
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { type SettingsRow, showSettingsPicker } from "@xynogen/pix-pretty/provider-picker";
import {
	type PixAgentState,
	type PixAgentStateEvent,
	registerPackageSettings,
} from "@xynogen/pix-runtime";
import { config, pixRuntime } from "@xynogen/pix-runtime/config";
import { spawnTool } from "@xynogen/pix-runtime/exec";
import { once } from "@xynogen/pix-runtime/once";
import { agentDir, expandHome } from "@xynogen/pix-runtime/paths";
import { currentPlatform, type HostOs, type HostPlatform } from "@xynogen/pix-runtime/platform";
import { type NotifyConfig, notifySection } from "@xynogen/pix-runtime/sections";

// ── System sounds: the OS ships both the sounds and a player. No ffmpeg. ─────

const AUDIO = /\.(oga|ogg|wav|aiff?)$/i;

/** Tried in order for `sound: "auto"`. Any other installed sound is one pick away in /pix. */
const PREFERRED: Partial<Record<HostOs, string[]>> = {
	linux: ["message-new-instant", "complete", "bell"],
	darwin: ["Glass", "Ping", "Tink"],
	win32: ["Windows Notify System Generic", "Windows Notify", "chimes"],
};

function soundDirs(host: HostPlatform, env: NodeJS.ProcessEnv): string[] {
	if (host.os === "darwin") return ["/System/Library/Sounds"];
	if (host.os === "win32") return [join(env.SystemRoot || env.windir || "C:\\Windows", "Media")];
	if (host.os !== "linux") return [];
	return (env.XDG_DATA_DIRS || "/usr/local/share:/usr/share")
		.split(":")
		.filter(Boolean)
		.map((dir) => join(dir, "sounds", "freedesktop", "stereo"));
}

/** Installed notification sounds by name ("message-new-instant", "Glass", …). */
export function systemSounds(
	host: HostPlatform = currentPlatform(),
	env: NodeJS.ProcessEnv = process.env,
): Map<string, string> {
	const sounds = new Map<string, string>();
	for (const dir of soundDirs(host, env)) {
		let files: string[];
		try {
			files = readdirSync(dir).sort();
		} catch {
			continue;
		}
		for (const file of files) {
			const name = file.slice(0, -extname(file).length);
			if (AUDIO.test(file) && !sounds.has(name)) sounds.set(name, join(dir, file));
		}
	}
	return sounds;
}

/** File for a configured sound: "auto", a system sound name, or a file path. */
export function resolveSound(
	choice: string,
	sounds: Map<string, string>,
	host: HostPlatform,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	if (choice !== "auto") return sounds.get(choice) ?? expandHome(choice, env);
	const name = (PREFERRED[host.os] ?? []).find((n) => sounds.has(n));
	return name ? sounds.get(name) : sounds.values().next().value;
}

/** `[program, ...args]` that plays `file` with the OS's own player. */
export function playArgs(file: string, host: HostPlatform): string[] | undefined {
	if (host.os === "linux") return ["paplay", file]; // or pw-play (catalog alias)
	if (host.os === "darwin") return ["afplay", file];
	if (host.os === "win32")
		return [
			"powershell",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`(New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`,
		];
	return undefined;
}

function startDetached(name: string, args: string[]): void {
	const child = spawnTool(name, args, { stdio: "ignore", detached: true });
	child.on("error", () => {});
	child.unref();
}

// ── Agent-state bridge ───────────────────────────────────────────────────────

export interface NotifyDeps {
	env?: NodeJS.ProcessEnv;
	host?: HostPlatform;
	settings?: () => Readonly<NotifyConfig>;
	/** Fire-and-forget start of a catalogued binary. Throws when it is missing. */
	start?: (name: string, args: string[]) => void;
	/** herdr's own Pi integration is installed (it listens for `herdr:blocked`). */
	herdrIntegration?: boolean;
}

function herdrIntegration(env: NodeJS.ProcessEnv): boolean {
	return existsSync(join(agentDir(env), "extensions", "herdr-agent-state.ts"));
}

/**
 * When the agent enters `blocked` (ask_user / gate / sudo waiting on the user),
 * ping the user once per entry. Inside a herdr pane with herdr's Pi integration,
 * forward the block as `herdr:blocked`: herdr shows `blocked` in its sidebar and
 * plays its own toast + sound. Without the integration: `herdr notification show`.
 * Outside herdr: the configured system sound through the OS player.
 */
export function bindNotify(events: EventBus, deps: NotifyDeps = {}): () => void {
	const env = deps.env ?? process.env;
	const host = deps.host ?? currentPlatform();
	const settings = deps.settings ?? (() => config(notifySection));
	const start = deps.start ?? startDetached;
	// The bridge reports state, not sound: it runs even with notify off.
	const bridge = env.HERDR_ENV === "1" && (deps.herdrIntegration ?? herdrIntegration(env));
	let last: PixAgentState | undefined;
	return events.on("pix:agent-state", (raw) => {
		const event = raw as PixAgentStateEvent;
		const entering = event.state === "blocked" && last !== "blocked";
		const leaving = event.state !== "blocked" && last === "blocked";
		last = event.state;
		const message = event.message ?? "Pi needs your attention";
		if (bridge) {
			if (entering) events.emit("herdr:blocked", { active: true, label: message });
			else if (leaving) events.emit("herdr:blocked", { active: false });
			return;
		}
		const cfg = settings();
		if (entering && cfg.enabled) notify(message, cfg.sound, env, host, start);
	});
}

function notify(
	message: string,
	sound: string,
	env: NodeJS.ProcessEnv,
	host: HostPlatform,
	start: (name: string, args: string[]) => void,
): void {
	try {
		if (env.HERDR_ENV === "1") {
			try {
				start("herdr", ["notification", "show", message, "--sound", "request"]);
				return;
			} catch {
				// herdr missing: fall through to the system sound
			}
		}
		const file = resolveSound(sound, systemSounds(host, env), host, env);
		const [name, ...args] = (file && playArgs(file, host)) || [];
		if (name) start(name, args);
	} catch {
		// missing player: a notification must never break the prompt path
	}
}

// ── /pix → Notify ────────────────────────────────────────────────────────────

function soundSource(env: NodeJS.ProcessEnv): string {
	if (env.HERDR_ENV !== "1") return "plays the selected system sound with the OS player";
	return herdrIntegration(env)
		? "herdr pane: herdr plays its own sound — change it in herdr's config.toml [ui.sound]"
		: "herdr pane: herdr notification with herdr's request sound";
}

function settingsRows(host: HostPlatform): SettingsRow[] {
	const cfg = config(notifySection);
	const sounds = systemSounds(host);
	const active = resolveSound("auto", sounds, host);
	const autoName = [...sounds].find(([, file]) => file === active)?.[0] ?? "none found";
	return [
		{
			key: "enabled",
			section: "When the agent waits on you",
			label: "notify",
			value: cfg.enabled ? "on" : "off",
			tone: cfg.enabled ? "success" : "muted",
		},
		{
			key: "sound",
			section: "When the agent waits on you",
			label: "sound",
			value: cfg.sound === "auto" ? `auto → ${autoName}` : cfg.sound,
			editable: true,
			choices: [
				{ value: "auto", hint: "OS default" },
				...[...sounds.keys()].map((value) => ({ value })),
			],
		},
		{
			key: "test",
			section: "When the agent waits on you",
			label: "test",
			value: "enter plays the sound",
			tone: "muted",
		},
	];
}

function checkSound(value: string, host: HostPlatform): string {
	if (value === "auto" || systemSounds(host).has(value)) return value;
	if (existsSync(expandHome(value))) return value;
	throw new Error(`"${value}" is not a system sound or an existing file`);
}

function registerSettings(pi: ExtensionAPI): void {
	registerPackageSettings(pi, {
		id: "pix-notify",
		label: "Notify",
		open: async (ctx: ExtensionCommandContext) => {
			const host = currentPlatform();
			await showSettingsPicker(ctx.ui, {
				title: `${icon("settings")} Notify Settings`,
				rows: () => settingsRows(host),
				status: () => ["", `  ${soundSource(process.env)}`],
				onAction: async ({ key, value }) => {
					const cfg = config(notifySection);
					if (key === "enabled")
						await pixRuntime().update(notifySection, { enabled: !cfg.enabled });
					else if (key === "sound" && value)
						await pixRuntime().update(notifySection, { sound: checkSound(value.trim(), host) });
					else if (key === "test") {
						const file = resolveSound(cfg.sound, systemSounds(host), host);
						const [name, ...args] = (file && playArgs(file, host)) || [];
						// Throws with the install hint; the modal shows it and stays open.
						if (!name) throw new Error(`no system sound or player on ${host.os}`);
						startDetached(name, args);
					}
					return undefined;
				},
			});
		},
	});
}

export default function pixNotify(pi: ExtensionAPI): void {
	once(pi, "pix-notify", () => {
		registerSettings(pi);
		const off = bindNotify(pi.events);
		pi.on("session_shutdown", () => off());
	});
}
