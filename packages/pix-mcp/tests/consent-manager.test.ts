import { beforeEach, describe, expect, it } from "bun:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { setUnattendedMode } from "@xynogen/pix-runtime";
import { ConsentManager } from "../src/consent-manager.ts";

describe("ConsentManager", () => {
	it("nuclear temporarily bypasses consent without caching approval", () => {
		const events = createEventBus();
		const manager = new ConsentManager("always", events);
		manager.registerDecision("server", false);
		setUnattendedMode(events, "nuclear");
		expect(manager.requiresPrompt("server")).toBe(false);
		expect(() => manager.ensureApproved("server")).not.toThrow();
		setUnattendedMode(events, "off");
		expect(manager.requiresPrompt("server")).toBe(true);
		expect(() => manager.ensureApproved("server")).toThrow();
	});
	describe("mode: never", () => {
		let manager: ConsentManager;

		beforeEach(() => {
			manager = new ConsentManager("never");
		});

		it("never requires prompt", () => {
			expect(manager.requiresPrompt("any-server")).toBe(false);
			expect(manager.requiresPrompt("another-server")).toBe(false);
		});

		it("should not cache consent", () => {
			// "never" mode means no consent needed, so caching is irrelevant
			// but the API returns true for consistency
			expect(manager.shouldCacheConsent()).toBe(true);
		});

		it("ensureApproved never throws", () => {
			expect(() => manager.ensureApproved("any-server")).not.toThrow();
		});

		it("registering denial has no effect", () => {
			manager.registerDecision("test-server", false);
			expect(manager.requiresPrompt("test-server")).toBe(false);
			expect(() => manager.ensureApproved("test-server")).not.toThrow();
		});
	});

	describe("mode: once-per-server (default)", () => {
		let manager: ConsentManager;

		beforeEach(() => {
			manager = new ConsentManager("once-per-server");
		});

		it("requires prompt for new servers", () => {
			expect(manager.requiresPrompt("server-a")).toBe(true);
			expect(manager.requiresPrompt("server-b")).toBe(true);
		});

		it("does not require prompt after approval", () => {
			manager.registerDecision("server-a", true);
			expect(manager.requiresPrompt("server-a")).toBe(false);
			// Other servers still require prompt
			expect(manager.requiresPrompt("server-b")).toBe(true);
		});

		it("requires prompt after denial", () => {
			manager.registerDecision("server-a", false);
			expect(manager.requiresPrompt("server-a")).toBe(true);
		});

		it("should cache consent", () => {
			expect(manager.shouldCacheConsent()).toBe(true);
		});

		it("ensureApproved throws for unapproved server", () => {
			expect(() => manager.ensureApproved("server-a")).toThrow(
				'Tool call approval required for "server-a"',
			);
		});

		it("ensureApproved throws for denied server", () => {
			manager.registerDecision("server-a", false);
			expect(() => manager.ensureApproved("server-a")).toThrow(
				'Tool calls for "server-a" were denied for this session',
			);
		});

		it("ensureApproved succeeds after approval", () => {
			manager.registerDecision("server-a", true);
			expect(() => manager.ensureApproved("server-a")).not.toThrow();
		});

		it("approval overrides previous denial", () => {
			manager.registerDecision("server-a", false);
			manager.registerDecision("server-a", true);
			expect(manager.requiresPrompt("server-a")).toBe(false);
			expect(() => manager.ensureApproved("server-a")).not.toThrow();
		});

		it("denial overrides previous approval", () => {
			manager.registerDecision("server-a", true);
			manager.registerDecision("server-a", false);
			expect(manager.requiresPrompt("server-a")).toBe(true);
			expect(() => manager.ensureApproved("server-a")).toThrow();
		});
	});

	describe("mode: always", () => {
		let manager: ConsentManager;

		beforeEach(() => {
			manager = new ConsentManager("always");
		});

		it("always requires prompt", () => {
			expect(manager.requiresPrompt("server-a")).toBe(true);
		});

		it("still requires prompt after approval", () => {
			manager.registerDecision("server-a", true);
			expect(manager.requiresPrompt("server-a")).toBe(true);
		});

		it("should not cache consent", () => {
			expect(manager.shouldCacheConsent()).toBe(false);
		});

		it("ensureApproved consumes the approval", () => {
			manager.registerDecision("server-a", true);
			// First call succeeds
			expect(() => manager.ensureApproved("server-a")).not.toThrow();
			// Second call fails (approval was consumed)
			expect(() => manager.ensureApproved("server-a")).toThrow(
				'Tool call approval required for "server-a"',
			);
		});
	});

	describe("clear", () => {
		let manager: ConsentManager;

		beforeEach(() => {
			manager = new ConsentManager("once-per-server");
			manager.registerDecision("server-a", true);
			manager.registerDecision("server-b", false);
		});

		it("clears specific server", () => {
			manager.clear("server-a");
			expect(manager.requiresPrompt("server-a")).toBe(true);
			// server-b unchanged
			expect(() => manager.ensureApproved("server-b")).toThrow(/denied/);
		});

		it("clears all servers", () => {
			manager.clear();
			expect(manager.requiresPrompt("server-a")).toBe(true);
			expect(manager.requiresPrompt("server-b")).toBe(true);
			// Neither approved nor denied
			expect(() => manager.ensureApproved("server-a")).toThrow(/approval required/);
			expect(() => manager.ensureApproved("server-b")).toThrow(/approval required/);
		});
	});
});
