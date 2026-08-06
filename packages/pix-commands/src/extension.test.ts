import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "./extension.ts";

afterEach(() => {
	delete (globalThis as { __pixOnce?: WeakMap<object, Set<string>> }).__pixOnce;
});

describe("pix-commands registration", () => {
	function host() {
		const commands: string[] = [];
		const renderers: string[] = [];
		const pi = {
			registerCommand(name: string) {
				commands.push(name);
			},
			registerEntryRenderer(name: string) {
				renderers.push(name);
			},
			on() {},
		} as unknown as ExtensionAPI;
		return { pi, commands, renderers };
	}

	test("registers /clear, /btw, and the BTW renderer once per Pi instance", () => {
		const { pi, commands, renderers } = host();
		extension(pi);
		extension(pi);
		expect(commands).toEqual(["clear", "btw"]);
		expect(renderers).toEqual(["pix-btw-answer"]);
	});

	test("registers again for a fresh Pi session", () => {
		const first = host();
		const second = host();
		extension(first.pi);
		extension(second.pi);
		expect(first.commands).toEqual(["clear", "btw"]);
		expect(second.commands).toEqual(["clear", "btw"]);
	});
});
