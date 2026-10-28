import { describe, expect, spyOn, test } from "bun:test";
import { registerBtw, shortModelName } from "./index.ts";
import * as session from "./session.ts";

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

test("a publish that throws does not re-publish the same answer as an error", async () => {
	const done = Promise.withResolvers<void>();
	const runner = spyOn(session, "runBtw").mockImplementation(async () => {
		setTimeout(done.resolve, 10);
		return { text: "ok", thinking: "", session: undefined as never };
	});
	try {
		const published: Array<{ error?: string }> = [];
		let handler!: (args: string, ctx: unknown) => Promise<void>;
		registerBtw({
			on() {},
			registerEntryRenderer() {},
			registerCommand: (_n: string, c: { handler: typeof handler }) => {
				handler = c.handler;
			},
			getThinkingLevel: () => "off",
			getActiveTools: () => [],
			appendEntry: (_name: string, details: { error?: string }) => {
				published.push(details);
				throw new Error("stale runtime");
			},
		} as never);
		await handler("--no-ctx q", {
			cwd: "/x",
			model: { provider: "p", id: "m" },
			sessionManager: { buildContextEntries: () => [] },
			ui: { notify() {}, setStatus() {}, setWidget() {} },
		});
		await done.promise;
		expect(published).toHaveLength(1);
		expect(published[0]?.error).toBeUndefined();
	} finally {
		runner.mockRestore();
	}
});
