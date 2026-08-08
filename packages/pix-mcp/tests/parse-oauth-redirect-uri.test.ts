import { describe, expect, it } from "bun:test";
import { parseOAuthRedirectUri } from "../src/mcp-auth-flow.ts";

describe("parseOAuthRedirectUri host mapping", () => {
	// "localhost" must bind the IPv4 loopback literal — Node can resolve
	// "localhost" to ::1 only, refusing http://127.0.0.1 redirects.
	it("maps localhost to 127.0.0.1", () => {
		expect(parseOAuthRedirectUri("http://localhost:39427/callback")).toEqual({
			port: 39427,
			callbackHost: "127.0.0.1",
			callbackPath: "/callback",
		});
	});

	it("keeps 127.0.0.1 as-is", () => {
		expect(parseOAuthRedirectUri("http://127.0.0.1:8080/cb")).toEqual({
			port: 8080,
			callbackHost: "127.0.0.1",
			callbackPath: "/cb",
		});
	});

	it("maps [::1] to ::1", () => {
		expect(parseOAuthRedirectUri("http://[::1]:8080/callback")).toEqual({
			port: 8080,
			callbackHost: "::1",
			callbackPath: "/callback",
		});
	});

	it("rejects non-loopback hosts", () => {
		expect(() => parseOAuthRedirectUri("http://example.com:8080/cb")).toThrow(/loopback/);
	});

	it("rejects https and missing port", () => {
		expect(() => parseOAuthRedirectUri("https://localhost:8080/cb")).toThrow(/http/);
		expect(() => parseOAuthRedirectUri("http://localhost/cb")).toThrow(/port/);
	});
});
