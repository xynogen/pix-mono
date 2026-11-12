import { expect, test } from "bun:test";
import { narrowTools } from "../src/agent-runner.ts";

test("omitting allowlist keeps the full resolved set", () => {
	expect(narrowTools(["read", "bash", "edit"])).toEqual(["read", "bash", "edit"]);
});

test("allowlist intersects — never widens", () => {
	expect(narrowTools(["read", "bash", "edit"], ["read", "write"])).toEqual(["read"]);
});

test("empty allowlist yields no tools", () => {
	expect(narrowTools(["read", "bash"], [])).toEqual([]);
});
