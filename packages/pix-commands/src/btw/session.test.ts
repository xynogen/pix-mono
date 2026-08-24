import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import {
	BTW_CTX_TURNS,
	BTW_SYSTEM_PROMPT,
	buildContextPreamble,
	lastAssistantText,
	makeLeanExtensions,
	selectBtwTools,
	snapshotMainSettings,
} from "./session.ts";

describe("BTW system prompt", () => {
	test("is the exact lean Pix identity", () => {
		expect(BTW_SYSTEM_PROMPT).toBe(
			"You are Pix Coding Agent. You help users accomplish any task they request.",
		);
	});
});

describe("snapshotMainSettings", () => {
	test("captures model, thinking, cwd, and a defensive copy of active tools", () => {
		const tools = ["read", "fetch"];
		const model = { id: "model-id", name: "Model" } as Model<Api>;
		const snapshot = snapshotMainSettings({ cwd: "/project", model } as never, "high", tools);
		tools.push("write");
		expect(snapshot.cwd).toBe("/project");
		expect(snapshot.model).toBe(model);
		expect(snapshot.thinkingLevel).toBe("high");
		expect(snapshot.activeToolNames).toEqual(["read", "fetch"]);
	});

	test("rejects invocation when the main session has no model", () => {
		expect(() =>
			snapshotMainSettings({ cwd: "/project", model: undefined } as never, "medium", []),
		).toThrow("No model is selected");
	});
});

describe("selectBtwTools", () => {
	test("uses the main active tools and removes duplicates without reordering", () => {
		expect(selectBtwTools(["read", "fetch", "read", "agent"])).toEqual(["read", "fetch", "agent"]);
	});
});

describe("makeLeanExtensions", () => {
	test("removes discovered before_agent_start mutators but preserves inline override", () => {
		const regularHandlers = new Map<string, never[]>([
			["before_agent_start", []],
			["tool_call", []],
		]);
		const inlineHandlers = new Map<string, never[]>([["before_agent_start", []]]);
		const base = {
			extensions: [
				{ path: "/extensions/pix-prompts.ts", handlers: regularHandlers },
				{ path: "<inline:1>", handlers: inlineHandlers },
			],
			errors: [],
			runtime: {},
		} as unknown as LoadExtensionsResult;

		const result = makeLeanExtensions(base);
		expect(result.extensions[0]?.handlers.has("before_agent_start")).toBe(false);
		expect(result.extensions[0]?.handlers.has("tool_call")).toBe(true);
		expect(result.extensions[1]?.handlers.has("before_agent_start")).toBe(true);
		// Do not mutate the loader's original extension records.
		expect(regularHandlers.has("before_agent_start")).toBe(true);
	});
});

describe("buildContextPreamble", () => {
	const msg = (role: string, text: string) => ({
		type: "message",
		message: { role, content: [{ type: "text", text }] },
	});

	test("flattens recent user/assistant turns into a labeled preamble", () => {
		const out = buildContextPreamble([msg("user", "hi"), msg("assistant", "hello")]);
		expect(out).toContain("User: hi");
		expect(out).toContain("Assistant: hello");
		expect(out).toContain("read-only context");
	});

	test("keeps only the last N turns", () => {
		const entries = Array.from({ length: BTW_CTX_TURNS + 5 }, (_, i) => msg("user", `q${i}`));
		const out = buildContextPreamble(entries);
		expect(out).not.toContain("q0"); // dropped
		expect(out).toContain(`q${BTW_CTX_TURNS + 4}`); // kept
		expect(out).toContain(`most recent ${BTW_CTX_TURNS} turn`);
	});

	test("skips non-message entries, tool noise, and string content", () => {
		const out = buildContextPreamble([
			{ type: "model_change", message: undefined },
			{ type: "message", message: { role: "tool", content: "ignored" } },
			{ type: "message", message: { role: "user", content: "plain string" } },
		]);
		expect(out).toContain("User: plain string");
		expect(out).not.toContain("ignored");
	});

	test("returns empty when there are no usable turns", () => {
		expect(buildContextPreamble([{ type: "compaction", message: undefined }])).toBe("");
		expect(buildContextPreamble([])).toBe("");
	});
});

describe("lastAssistantText", () => {
	test("returns text from the latest assistant response", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "text", text: "old" }] },
			{ role: "user", content: "question" },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "hidden" },
					{ type: "text", text: "latest" },
				],
			},
		];
		expect(lastAssistantText(messages)).toBe("latest");
	});

	test("returns an empty string when there is no assistant text", () => {
		expect(lastAssistantText([{ role: "user", content: "hello" }])).toBe("");
	});
});
