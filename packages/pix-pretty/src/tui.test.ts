import { expect, test } from "bun:test";
import * as tui from "./tui.ts";

// A Pi upgrade that drops a re-exported name fails here, not in every consumer.
test("every tui value export is defined", () => {
	const missing = Object.entries(tui)
		.filter(([, value]) => value === undefined)
		.map(([key]) => key);
	expect(missing).toEqual([]);
});
