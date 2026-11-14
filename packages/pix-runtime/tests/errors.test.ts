import { expect, test } from "bun:test";
import { getErrorMessage } from "../src/errors.ts";

test("getErrorMessage reads Error.message and stringifies anything else", () => {
	expect(getErrorMessage(new Error("boom"))).toBe("boom");
	expect(getErrorMessage("plain")).toBe("plain");
	expect(getErrorMessage(42)).toBe("42");
});
