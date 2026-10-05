import { expect, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { captureRows, roleTheme, withUiFixture } from "../../../scripts/ui-capture.ts";
import thinkingExtension from "../src/thinking.ts";

test("native assistant thinking hooks and code frames", async () => {
	const fixture = await withUiFixture({ hostTheme: true });
	const prototype = AssistantMessageComponent.prototype;
	const patched = Symbol.for("@xynogen/pix-display:code-block-renderer");
	const descriptors = ["render", patched].map(
		(key) => [key, Object.getOwnPropertyDescriptor(prototype, key)] as const,
	);
	const hooks = new Map<
		string,
		(
			event: { message: AssistantMessage; assistantMessageEvent?: { type: string } },
			ctx?: unknown,
		) => { message: AssistantMessage } | undefined
	>();
	const pi = { on: (name: string, hook: never) => hooks.set(name, hook) };
	const message = (text: string): AssistantMessage => ({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "fixture",
		model: "capture",
		stopReason: "stop",
		timestamp: 0,
		usage: {
			input: 10,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 30,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	const states: Record<string, string[]> = {};
	try {
		// ponytail: a fresh module owns private activeTheme. Restore the shared prototype below.
		const path = "../src/code-blocks.ts?display-capture";
		const code = (await import(path)) as typeof import("../src/code-blocks.ts");
		Reflect.deleteProperty(prototype, patched);
		code.default(pi as never);
		hooks.get("session_start")?.(
			{ message: message("") },
			{ mode: "tui", ui: { theme: roleTheme() } },
		);
		thinkingExtension(pi as never);
		const take = (
			name: string,
			msg: AssistantMessage,
			hidden = false,
			width = 80,
			streaming = false,
		) => {
			const component = new AssistantMessageComponent(msg, hidden, getMarkdownTheme());
			component.updateContent(msg, streaming);
			states[name] = captureRows(component, { width, surface: "component", osc133: true });
		};
		const source = message(
			'<think>Check **source** first.</think>\n\n# Answer\n\n```python title=example\ndef greet(name):\n    print(name)\n```\n\n```json\n{"ok": true}\n```',
		);
		const providerBlock = source.content[0];
		const live = { ...source, content: [...source.content] };
		hooks.get("message_update")?.({ message: live, assistantMessageEvent: { type: "text_delta" } });
		expect(source.content[0]).toBe(providerBlock);
		expect(source.content[0]).toEqual({ type: "text", text: expect.stringContaining("<think>") });
		expect(live.content.map((block) => block.type)).toEqual(["thinking", "text"]);
		take("visible / 80", live);
		take("hidden / 80", live, true);
		const ended = hooks.get("message_end")?.({
			message: { ...source, content: [...source.content] },
		});
		expect(ended?.message.content).toEqual(live.content);
		const signed = {
			type: "thinking" as const,
			thinking: "Signed reason",
			thinkingSignature: "signature-bytes",
		};
		const final = message("Answer");
		final.content.push(signed);
		hooks.get("message_end")?.({ message: final });
		expect(final.content[0]).toBe(signed);
		expect(signed.thinkingSignature).toBe("signature-bytes");
		take("signed / 80", final);
		const user = {
			role: "user",
			content: "<think>user bytes</think>",
			chipPayload: { path: "file.ts", raw: "payload bytes" },
		};
		hooks.get("message_update")?.({ message: user as never });
		hooks.get("message_end")?.({ message: user as never });
		expect(user).toEqual({
			role: "user",
			content: "<think>user bytes</think>",
			chipPayload: { path: "file.ts", raw: "payload bytes" },
		});
		const stream = message("<thinking>Still checking</thi");
		hooks.get("message_update")?.({
			message: stream,
			assistantMessageEvent: { type: "text_delta" },
		});
		take("stream thinking / 80", stream, false, 80, true);
		take("stream fence / 80", message("```python\nprint(1)"), false, 80, true);
		take("long code / 80", message(`\`\`\`custom-language\n${"long source ".repeat(10)}\n\`\`\``));
		take("native narrow bypass / 11", message("```text\nx\n```"), false, 11);
		expect(states).toMatchSnapshot();
	} finally {
		for (const [key, descriptor] of descriptors) {
			if (descriptor) Object.defineProperty(prototype, key, descriptor);
			else Reflect.deleteProperty(prototype, key);
		}
		await fixture.restore();
	}
	for (const [key, descriptor] of descriptors)
		expect(Object.getOwnPropertyDescriptor(prototype, key)).toEqual(descriptor);
});
