import { expect, test } from "bun:test";
import {
	addUsage,
	getLifetimeTotal,
	getSessionContextPercent,
	getSessionContextUsage,
} from "../src/usage.ts";

test("getLifetimeTotal sums all three fields", () => {
	expect(getLifetimeTotal({ input: 100, output: 200, cacheWrite: 50 })).toBe(350);
});

test("getLifetimeTotal returns 0 for undefined", () => {
	expect(getLifetimeTotal(undefined)).toBe(0);
});

test("addUsage mutates target correctly", () => {
	const acc = { input: 10, output: 20, cacheWrite: 5 };
	addUsage(acc, { input: 5, output: 10, cacheWrite: 2 });
	expect(acc).toEqual({ input: 15, output: 30, cacheWrite: 7 });
});

// getSessionContextPercent still works, reimplemented via getSessionContextUsage

test("getSessionContextPercent returns null for undefined", () => {
	expect(getSessionContextPercent(undefined)).toBeNull();
});

test("getSessionContextPercent reads percent", () => {
	const session = {
		getSessionStats: () => ({
			tokens: { input: 0, output: 0, cacheWrite: 0 },
			contextUsage: { percent: 42 },
		}),
	};
	expect(getSessionContextPercent(session)).toBe(42);
});

// getSessionContextUsage tests

test("getSessionContextUsage returns null for undefined session", () => {
	expect(getSessionContextUsage(undefined)).toBeNull();
});

test("getSessionContextUsage returns full usage object", () => {
	const session = {
		getSessionStats: () => ({
			tokens: { input: 0, output: 0, cacheWrite: 0 },
			contextUsage: { tokens: 30100, contextWindow: 1000000, percent: 3 },
		}),
	};
	expect(getSessionContextUsage(session)).toEqual({
		tokens: 30100,
		contextWindow: 1000000,
		percent: 3,
	});
});

test("getSessionContextUsage returns null when contextUsage absent", () => {
	const session = {
		getSessionStats: () => ({
			tokens: { input: 0, output: 0, cacheWrite: 0 },
		}),
	};
	expect(getSessionContextUsage(session)).toBeNull();
});

test("getSessionContextUsage returns null when getSessionStats throws", () => {
	const session = {
		getSessionStats: () => {
			throw new Error("boom");
		},
	};
	expect(getSessionContextUsage(session)).toBeNull();
});
