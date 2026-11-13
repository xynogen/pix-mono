/** nine-router.ts — 9Router endpoint and key from the environment, shared by every 9Router client. */

/** Bearer key from NINEROUTER_KEY, or the legacy ROUTER_API_KEY. "" when unset. */
export function routerKey(): string {
	return process.env.NINEROUTER_KEY || process.env.ROUTER_API_KEY || "";
}

/** Base URL from NINEROUTER_URL / ROUTER_API_BASE, with `/v1` appended. No default: an
 * unset URL means 9Router is not configured, so callers must not send a request. */
export function routerBaseUrl(): string | undefined {
	const configured = (process.env.NINEROUTER_URL || process.env.ROUTER_API_BASE)?.trim();
	if (!configured) return undefined;
	const base = configured.replace(/\/+$/, "");
	return base.endsWith("/v1") ? base : `${base}/v1`;
}

export function requireRouterBase(): string {
	const base = routerBaseUrl();
	if (!base) throw new Error("9Router is not configured: set NINEROUTER_URL");
	return base;
}
