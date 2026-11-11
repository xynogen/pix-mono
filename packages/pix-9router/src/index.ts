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
import registerProvider from "./provider.ts";

export default async function (pi: ExtensionAPI): Promise<void> {
	await registerProvider(pi);
}
