import { describe, expect, test } from "bun:test";
import { registerBtw, shortModelName } from "./index.ts";

describe("BTW display helpers", () => {
	test("prefers model display name and falls back to id", () => {
		expect(shortModelName({ id: "id", name: "Friendly" })).toBe("Friendly");
		expect(shortModelName({ id: "id", name: "  " })).toBe("id");
	});

	test("registers a display-only entry renderer, never a context-bearing message renderer", () => {
		let entryRenderer: string | undefined;
		let messageRenderer: string | undefined;
		const pi = {
			on() {},
			registerCommand() {},
			registerEntryRenderer(name: string) {
				entryRenderer = name;
			},
			registerMessageRenderer(name: string) {
				messageRenderer = name;
			},
		} as any;
		registerBtw(pi);

		// pix-btw-answer must be a CustomEntry (display-only, never in LLM context),
		// not a CustomMessageEntry — that is what lets the card land mid-stream.
		expect(entryRenderer).toBe("pix-btw-answer");
		expect(messageRenderer).toBeUndefined();
	});

	test("does not register a context handler (BTW cards never enter LLM context)", () => {
		const events: string[] = [];
		const pi = {
			on(event: string) {
				events.push(event);
			},
			registerCommand() {},
			registerEntryRenderer() {},
		} as any;
		registerBtw(pi);

		// A CustomEntry is ignored by buildSessionContext, so there is nothing to
		// strip — the old pi.on("context", filterBtwMessages) hack is gone.
		expect(events).not.toContain("context");
	});
});
