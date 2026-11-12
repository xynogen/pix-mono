import { expect, test } from "bun:test";
import * as ai from "../src/ai.ts";

// A pi-ai upgrade that drops a re-exported name fails here, not in every consumer.
test("every ai value export is defined", () => {
	const missing = Object.entries(ai)
		.filter(([, value]) => value === undefined)
		.map(([key]) => key);
	expect(missing).toEqual([]);
});

test("builtinProviders includes the TypeSafe classifier", async () => {
	const providers = await ai.builtinProviders();
	expect(providers.some((provider) => provider.id === "typesafe")).toBe(true);
});
