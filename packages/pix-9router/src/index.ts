/**
 * pix-9router — Pi extension
 *
 * Registers the 9router model provider (model list from the self-hosted router API).
 * Speech tools moved to @xynogen/pix-voice. Web search and fetch live in
 * @xynogen/pix-web. Both reuse the same 9Router environment variables.
 *
 * Environment:
 *   NINEROUTER_URL   — canonical base URL
 *   NINEROUTER_KEY   — canonical bearer token
 *   ROUTER_API_BASE / ROUTER_API_KEY — legacy aliases
 */

import type { ExtensionAPI } from "@xynogen/pix-runtime/host";
import { once } from "@xynogen/pix-runtime/once";
import registerProvider from "./provider.ts";

export default async function pix9Router(pi: ExtensionAPI): Promise<void> {
	let run: Promise<void> | undefined;
	once(pi, "pix-9router", () => {
		run = registerProvider(pi);
	});
	await run;
}
