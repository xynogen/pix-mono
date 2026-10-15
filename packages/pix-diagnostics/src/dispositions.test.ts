import { describe, expect, test } from "bun:test";
import { DispositionStore } from "./dispositions.ts";
import { registerMarkTool } from "./tools/mark-tool.ts";

interface Tool {
	name: string;
	execute: (
		id: string,
		params: Record<string, unknown>,
	) => Promise<{ content: Array<{ text: string }>; details?: unknown; isError?: boolean }>;
}

function captureMark(store: DispositionStore, cwd = "/repo"): Tool {
	let tool: Tool | undefined;
	const pi = {
		registerTool(def: Tool) {
			tool = def;
		},
	};
	registerMarkTool(pi as never, { store, cwd });
	if (!tool) throw new Error("tool not registered");
	return tool;
}

describe("DispositionStore", () => {
	test("set overwrites the same file+code and list is newest-first", () => {
		let clock = 1;
		const store = new DispositionStore(() => clock++);
		store.set("/repo/a.ts", "TS2322", "defer");
		store.set("/repo/b.ts", "TS2345", "flagged", "later");
		store.set("/repo/a.ts", "TS2322", "false-positive");
		const list = store.list();
		expect(list).toHaveLength(2);
		expect(list[0]?.code).toBe("TS2322");
		expect(list[0]?.disposition).toBe("false-positive");
	});

	test("delete removes one record", () => {
		const store = new DispositionStore();
		store.set("/repo/a.ts", "X", "suppress");
		expect(store.delete("/repo/a.ts", "X")).toBe(true);
		expect(store.list()).toHaveLength(0);
	});
});

describe("lsp_diagnostic_mark tool", () => {
	test("set requires path, code, and disposition", async () => {
		const tool = captureMark(new DispositionStore());
		await expect(tool.execute("t", { action: "set", path: "a.ts" })).rejects.toThrow("disposition");
	});

	test("set then list shows the marked finding", async () => {
		const store = new DispositionStore();
		const tool = captureMark(store);
		await tool.execute("t", { action: "set", path: "a.ts", code: "TS2322", disposition: "defer" });
		const res = await tool.execute("t", { action: "list" });
		expect((res.details as { count: number }).count).toBe(1);
		expect(res.content[0]?.text).toContain("a.ts");
		expect(res.content[0]?.text).toContain("defer");
	});

	test("clear with no args clears all", async () => {
		const store = new DispositionStore();
		const tool = captureMark(store);
		await tool.execute("t", { action: "set", path: "a.ts", code: "X", disposition: "suppress" });
		const res = await tool.execute("t", { action: "clear" });
		expect((res.details as { cleared: number }).cleared).toBe(1);
		expect(store.list()).toHaveLength(0);
	});
});
