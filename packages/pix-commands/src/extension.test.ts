import { afterEach, describe, expect, test } from "bun:test";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { icon } from "@xynogen/pix-pretty/icon-catalog";
import { getUnattendedMode } from "@xynogen/pix-runtime";
import extension from "./extension.ts";

afterEach(() => {
	delete (globalThis as { __pixOnce?: WeakMap<object, Set<string>> }).__pixOnce;
});

describe("pix-commands registration", () => {
	function host() {
		const commands: string[] = [];
		const handlers = new Map<string, (args: string, ctx: never) => Promise<void>>();
		const renderers: string[] = [];
		const pi = {
			events: createEventBus(),
			registerCommand(
				name: string,
				options: { handler?: (args: string, ctx: never) => Promise<void> },
			) {
				commands.push(name);
				if (options.handler) handlers.set(name, options.handler);
			},
			registerEntryRenderer(name: string) {
				renderers.push(name);
			},
			on() {},
		} as unknown as ExtensionAPI;
		return { pi, commands, handlers, renderers };
	}

	test("registers /clear, /btw, /afk, /yolo, and the BTW renderer once per Pi instance", () => {
		const { pi, commands, renderers } = host();
		extension(pi);
		extension(pi);
		expect(commands).toEqual(["clear", "btw", "afk", "yolo"]);
		expect(renderers).toEqual(["pix-btw-answer"]);
	});

	test("registers again for a fresh Pi session", () => {
		const first = host();
		const second = host();
		extension(first.pi);
		extension(second.pi);
		expect(first.commands).toEqual(["clear", "btw", "afk", "yolo"]);
		expect(second.commands).toEqual(["clear", "btw", "afk", "yolo"]);
	});

	test("/afk toggles shared state and status", async () => {
		const { pi, handlers } = host();
		extension(pi);
		const statuses: Array<string | undefined> = [];
		const notices: string[] = [];
		const ctx = {
			ui: {
				theme: { fg: (color: string, text: string) => `<${color}>${text}</${color}>` },
				setStatus: (_key: string, text: string | undefined) => statuses.push(text),
				notify: (text: string) => notices.push(text),
			},
		};
		const handler = handlers.get("afk");
		if (!handler) throw new Error("/afk not registered");

		await handler("", ctx as never);
		expect(getUnattendedMode(pi.events)).toBe("afk");
		expect(statuses.at(-1)).toBe(`<error>${icon("afk")} AFK</error>`);
		expect(notices.at(-1)).toContain("yellow gates auto-allow");

		await handler("", ctx as never);
		expect(getUnattendedMode(pi.events)).toBe("off");
		expect(statuses.at(-1)).toBeUndefined();
	});
});
