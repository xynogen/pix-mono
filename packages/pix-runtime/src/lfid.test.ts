import { describe, expect, test } from "bun:test";
import { generateLfid, isLfid, LFID_RE, parseLfid, uniqueLfid } from "./lfid.ts";

describe("lfid", () => {
	test("generateLfid matches the LFID shape", () => {
		for (let i = 0; i < 50; i++) {
			const id = generateLfid();
			expect(LFID_RE.test(id)).toBe(true);
			expect(id.startsWith("agent-")).toBe(true);
		}
	});

	test("custom prefix is honored", () => {
		expect(generateLfid({ prefix: "job" }).startsWith("job-")).toBe(true);
	});

	test("deterministic rng produces a fixed LFID", () => {
		const id = generateLfid({ prefix: "agent", rand: () => 0 });
		expect(id).toBe("agent-agate-adder-00");
	});

	test("isLfid accepts shape, rejects UUIDs and junk", () => {
		expect(isLfid("agent-happy-walrus-42")).toBe(true);
		expect(isLfid("job-swift-fox-73")).toBe(true);
		expect(isLfid("3f2a1b9c-4d5e-6f7")).toBe(false);
		expect(isLfid("abc123")).toBe(false);
		expect(isLfid("")).toBe(false);
	});

	test("parseLfid splits parts, rejects junk", () => {
		expect(parseLfid("agent-happy-walrus-42")).toEqual({
			prefix: "agent",
			adjective: "happy",
			noun: "walrus",
			num: "42",
		});
		expect(parseLfid("not-an-id")).toBeUndefined();
	});

	test("uniqueLfid retries past collisions", () => {
		// First generated value is "claimed", second must differ.
		const first = generateLfid({ rand: () => 0 });
		expect(first).toBe("agent-agate-adder-00");
		let n = 0;
		const id = uniqueLfid((s) => s === first, { rand: () => n++ });
		expect(isLfid(id)).toBe(true);
		expect(id).not.toBe(first);
	});

	test("uniqueLfid throws on an exhausted namespace", () => {
		expect(() => uniqueLfid(() => true)).toThrow("namespace exhausted");
	});

	test("each word list has 100 distinct short words", () => {
		for (const at of [1, 2] as const) {
			const words = new Set<string>();
			for (let i = 0; i < 100; i++) {
				const word = generateLfid({ rand: () => i }).split("-")[at];
				words.add(word ?? "");
			}
			expect(words.size).toBe(100);
			for (const word of words) expect(word).toMatch(/^[a-z]{2,9}$/);
		}
	});
});
