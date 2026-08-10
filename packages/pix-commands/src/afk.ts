import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { icon } from "@xynogen/pix-pretty/icon-catalog";

const STATUS_KEY = "afk";

type AfkGlobal = typeof globalThis & { __pixAfk?: boolean };
type StatusUI = {
	theme: { fg(color: "error", text: string): string };
	setStatus(key: string, text: string | undefined): void;
};

function setAfkStatus(ui: StatusUI, active: boolean): void {
	ui.setStatus(STATUS_KEY, active ? ui.theme.fg("error", `${icon("afk")} AFK`) : undefined);
}

export default function registerAfk(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		setAfkStatus(ctx.ui, (globalThis as AfkGlobal).__pixAfk === true);
	});

	pi.registerCommand("afk", {
		description: "Toggle unattended gate behavior",
		handler: async (_args, ctx) => {
			const state = !(globalThis as AfkGlobal).__pixAfk;
			(globalThis as AfkGlobal).__pixAfk = state;
			setAfkStatus(ctx.ui, state);
			ctx.ui.notify(
				state
					? "AFK mode on — yellow gates auto-allow; red and sudo auto-deny."
					: "AFK mode off — approval prompts restored.",
				state ? "warning" : "info",
			);
		},
	});
}
