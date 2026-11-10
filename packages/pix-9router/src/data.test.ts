import { afterEach, describe, expect, it } from "bun:test";
import { routerBaseUrl } from "./data.ts";

// ── routerBaseUrl ────────────────────────────────────────────────────────────

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
});
