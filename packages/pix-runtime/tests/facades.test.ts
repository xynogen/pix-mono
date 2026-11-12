import { describe, expect, test } from "bun:test";
import * as crypto from "../src/crypto.ts";
import * as fs from "../src/fs.ts";
import * as host from "../src/host.ts";
import * as net from "../src/net.ts";

// A Pi or Node upgrade that drops a re-exported name fails here, not in every consumer.
describe.each([
	["host", host],
	["fs", fs],
	["crypto", crypto],
	["net", net],
])("%s facade", (_name, mod) => {
	test("every value export is defined", () => {
		const missing = Object.entries(mod)
			.filter(([, value]) => value === undefined)
			.map(([key]) => key);
		expect(missing).toEqual([]);
	});
});

test("codemodeExtension returns the host factory", () => {
	expect(typeof host.codemodeExtension()).toBe("function");
});

test("freePort returns a usable loopback port", async () => {
	const port = await net.freePort();
	expect(port).toBeGreaterThan(0);
	expect(port).toBeLessThan(65536);
});
