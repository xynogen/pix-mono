import { expect, mock, test } from "bun:test";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { getUnattendedMode, setUnattendedMode } from "@xynogen/pix-runtime";

let action = "denied";
const overlay = mock(async () => ({ action }));
mock.module("@xynogen/pix-pretty/gate-overlay", () => ({ showOverlay: overlay }));
const { default: register, unattendedBanner } = await import("./unattended.ts");

test("nuclear requires UI consent, shows rocket status, toggles, and resets on new sessions", async () => {
	const events = createEventBus();
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const hooks = new Map<string, (...args: any[]) => unknown>();
	register({
		events,
		registerCommand: (name: string, spec: any) => commands.set(name, spec.handler),
		on: (name: string, fn: any) => hooks.set(name, fn),
	} as unknown as ExtensionAPI);
	const statuses: Array<string | undefined> = [];
	const ctx = {
		hasUI: false,
		ui: {
			theme: { fg: (_: string, s: string) => s },
			setStatus: (_: string, s: string | undefined) => statuses.push(s),
			notify() {},
		},
	};
	const command = commands.get("nuclear")!;
	await command("", ctx);
	expect(overlay).not.toHaveBeenCalled();
	expect(getUnattendedMode(events)).toBe("off");
	ctx.hasUI = true;
	setUnattendedMode(events, "afk");
	await command("", ctx);
	expect(getUnattendedMode(events)).toBe("afk");
	action = "approved";
	await command("", ctx);
	expect(getUnattendedMode(events)).toBe("nuclear");
	expect(statuses.at(-1)).toBe(`${icon("mode.nuclear")} NUCLEAR`);
	expect(unattendedBanner(events)).toContain('mode="nuclear"');
	await command("", ctx);
	expect(getUnattendedMode(events)).toBe("off");
	expect(statuses.at(-1)).toBeUndefined();
	await command("", ctx);
	hooks.get("session_start")!({}, ctx);
	expect(getUnattendedMode(events)).toBe("off");
	expect(statuses.at(-1)).toBeUndefined();
});
