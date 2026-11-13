import { afterEach, describe, expect, it } from "bun:test";
import { requireRouterBase, routerBaseUrl, routerKey } from "../src/nine-router.ts";

describe("routerKey", () => {
	const saved = { a: process.env.NINEROUTER_KEY, b: process.env.ROUTER_API_KEY };
	afterEach(() => {
		if (saved.a === undefined) delete process.env.NINEROUTER_KEY;
		else process.env.NINEROUTER_KEY = saved.a;
		if (saved.b === undefined) delete process.env.ROUTER_API_KEY;
		else process.env.ROUTER_API_KEY = saved.b;
	});

	it("prefers NINEROUTER_KEY, falls back to ROUTER_API_KEY, else empty", () => {
		delete process.env.NINEROUTER_KEY;
		delete process.env.ROUTER_API_KEY;
		expect(routerKey()).toBe("");
		process.env.ROUTER_API_KEY = "legacy";
		expect(routerKey()).toBe("legacy");
		process.env.NINEROUTER_KEY = "canon";
		expect(routerKey()).toBe("canon");
	});
});

describe("routerBaseUrl", () => {
	const ORIGINAL_ROUTER_API_BASE = process.env.ROUTER_API_BASE;
	const ORIGINAL_NINEROUTER_URL = process.env.NINEROUTER_URL;

	afterEach(() => {
		if (ORIGINAL_ROUTER_API_BASE === undefined) delete process.env.ROUTER_API_BASE;
		else process.env.ROUTER_API_BASE = ORIGINAL_ROUTER_API_BASE;
		if (ORIGINAL_NINEROUTER_URL === undefined) delete process.env.NINEROUTER_URL;
		else process.env.NINEROUTER_URL = ORIGINAL_NINEROUTER_URL;
	});

	it("returns undefined when no URL is configured (no default host)", () => {
		delete process.env.ROUTER_API_BASE;
		delete process.env.NINEROUTER_URL;
		expect(routerBaseUrl()).toBeUndefined();
		process.env.NINEROUTER_URL = "   ";
		expect(routerBaseUrl()).toBeUndefined();
	});

	it("appends /v1 to a bare base URL", () => {
		process.env.NINEROUTER_URL = "https://router.test/";
		expect(routerBaseUrl()).toBe("https://router.test/v1");
	});

	it("uses ROUTER_API_BASE when set", () => {
		delete process.env.NINEROUTER_URL;
		process.env.ROUTER_API_BASE = "https://my.router.dev/v1";
		expect(routerBaseUrl()).toBe("https://my.router.dev/v1");
	});

	it("strips trailing slash", () => {
		delete process.env.NINEROUTER_URL;
		process.env.ROUTER_API_BASE = "https://my.router.dev/v1/";
		expect(routerBaseUrl()).toBe("https://my.router.dev/v1");
	});

	it("requireRouterBase throws when unset", () => {
		delete process.env.ROUTER_API_BASE;
		delete process.env.NINEROUTER_URL;
		expect(() => requireRouterBase()).toThrow("set NINEROUTER_URL");
		process.env.NINEROUTER_URL = "https://r.test";
		expect(requireRouterBase()).toBe("https://r.test/v1");
	});
});
