import { expect, test } from "bun:test";
import { registerFetchProvider } from "../src/providers.ts";
import { registerSearchProvider } from "../src/search-providers.ts";
import { webTool } from "../src/web-tool.ts";

for (const name of ["fetch", "search"] as const) {
	test(`web ${name} pre-abort skips providers and progress; late provider success stays cancelled`, async () => {
		const tool = webTool();
		const target = name === "fetch" ? { url: "https://example.test" } : { query: "test" };
		const args = { action: name, ...target };
		let calls = 0;
		let updates = 0;
		let fail = false;
		let complete!: () => void;
		const provider = async () => {
			calls++;
			if (fail) throw new Error("provider unavailable");
			await new Promise<void>((resolve) => {
				complete = resolve;
			});
		};
		if (name === "fetch")
			registerFetchProvider({
				id: "lifecycle-fetch",
				fetch: async () => {
					await provider();
					return { url: "https://example.test", content: "late response" };
				},
			});
		else
			registerSearchProvider({
				id: "lifecycle-search",
				search: async () => {
					await provider();
					return [];
				},
			});
		const onUpdate = () => {
			updates++;
		};
		const pre = await tool.execute("pre", args, AbortSignal.abort(), onUpdate, {} as never);
		expect(pre).toEqual({
			content: [
				{ type: "text", text: name === "fetch" ? "Fetch cancelled." : "Search cancelled." },
			],
			details: {
				outcome: "cancelled",
				target: name === "fetch" ? target.url : target.query,
				meta: "cancelled",
			},
		});
		expect({ calls, updates }).toEqual({ calls: 0, updates: 0 });
		const controller = new AbortController();
		const pending = tool.execute("late", args, controller.signal, onUpdate, {} as never);
		expect({ calls, updates }).toEqual({ calls: 1, updates: 1 });
		controller.abort(new Error("cancel"));
		complete();
		const result = await pending;
		expect(result.details).toMatchObject({ outcome: "cancelled" });
		expect((result as { isError?: boolean }).isError).not.toBe(true);
		expect(updates).toBe(1);
		fail = true;
		const failed = await tool.execute("failure", args, undefined, undefined, {} as never);
		expect(failed).toMatchObject({
			content: [{ type: "text", text: expect.stringContaining("provider unavailable") }],
			details: {
				outcome: "error",
				target: name === "fetch" ? target.url : target.query,
				meta: "failed",
			},
			isError: true,
		});
	});
}
