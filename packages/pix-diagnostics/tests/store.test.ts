import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { DiagnosticStore } from "../src/store.ts";

const error = {
	filePath: "/repo/src/a.ts",
	severity: "error" as const,
	message: "Cannot find name 'x'.",
	line: 3,
	column: 4,
};

describe("DiagnosticStore", () => {
	test("keeps canonical snapshots and orders recent files", () => {
		const store = new DiagnosticStore(2);
		store.set({
			filePath: "/repo/src/a.ts",
			diagnostics: [error],
			checkedAt: 1,
			state: "findings",
		});
		store.set({ filePath: "/repo/src/b.ts", diagnostics: [], checkedAt: 2, state: "clean" });

		// The store keys on resolve(): POSIX paths gain a drive letter on Windows.
		expect(store.recent().map((item) => item.filePath)).toEqual([
			resolve("/repo/src/b.ts"),
			resolve("/repo/src/a.ts"),
		]);
		expect(store.get("/repo/src/a.ts")?.diagnostics).toEqual([error]);
	});

	test("evicts the least recent snapshot at its bound", () => {
		const store = new DiagnosticStore(2);
		for (const [filePath, checkedAt] of [
			["/a.ts", 1],
			["/b.ts", 2],
			["/c.ts", 3],
		] as const) {
			store.set({ filePath, diagnostics: [], checkedAt, state: "clean" });
		}

		expect(store.recent().map((item) => item.filePath)).toEqual([
			resolve("/c.ts"),
			resolve("/b.ts"),
		]);
	});

	test("notifies one listener once for one write", () => {
		const store = new DiagnosticStore();
		let calls = 0;
		store.subscribe(() => calls++);
		store.set({ filePath: "/a.ts", diagnostics: [], checkedAt: 1, state: "clean" });
		expect(calls).toBe(1);
	});
});
