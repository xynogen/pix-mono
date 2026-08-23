// Self-contained replacements for the three @modelcontextprotocol/ext-apps
// /app-bridge helpers pix consumes. That subpath imports the MCP SDK *v1*
// (@modelcontextprotocol/sdk/types.js) at runtime and declares it as a peer,
// so importing it from published pix-mcp — which no longer depends on the v1
// SDK — crashes a clean install. Ported from upstream pi-mcp-adapter's
// ui-app-bridge-helpers.ts (MIT), which made the same move.
import type { UiResourcePermissions } from "./types.ts";

export const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

const RESOURCE_URI_META_KEY = "ui/resourceUri";

export function getToolUiResourceUri(tool: {
	_meta?: Record<string, unknown> | undefined;
}): string | undefined {
	const meta = tool._meta;
	let resourceUri = getNestedResourceUri(meta);
	if (resourceUri === undefined) {
		resourceUri = meta?.[RESOURCE_URI_META_KEY];
	}

	if (typeof resourceUri === "string" && resourceUri.startsWith("ui://")) {
		return resourceUri;
	}

	if (resourceUri !== undefined) {
		throw new Error(`Invalid UI resource URI: ${JSON.stringify(resourceUri)}`);
	}

	return undefined;
}

export function buildAllowAttribute(permissions: UiResourcePermissions | undefined): string {
	if (!permissions) return "";

	const allowed: string[] = [];
	if (permissions.camera) allowed.push("camera");
	if (permissions.microphone) allowed.push("microphone");
	if (permissions.geolocation) allowed.push("geolocation");
	if (permissions.clipboardWrite) allowed.push("clipboard-write");
	return allowed.join("; ");
}

function getNestedResourceUri(meta: Record<string, unknown> | undefined): unknown {
	const ui = meta?.ui;
	if (!ui || typeof ui !== "object") return undefined;
	return (ui as Record<string, unknown>).resourceUri;
}
