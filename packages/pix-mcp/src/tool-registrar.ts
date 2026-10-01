// tool-registrar.ts - MCP content transformation
// NOTE: Tools are NOT registered with Pi - only the unified `mcp` proxy tool is registered.
// This keeps the LLM context small (1 tool instead of 100s).

import type { ContentBlock, McpContent } from "./types.ts";

// Provider-accepted image types. Anything else persisted in history fails every later request.
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** A provider-safe image block, or the reason it is not one. */
function imageBlock(data: string | undefined, mimeType: string | undefined): ContentBlock {
	const mime = mimeType?.toLowerCase() ?? "";
	const clean = data?.replace(/\s+/g, "") ?? "";
	if (!IMAGE_MIME_TYPES.has(mime))
		return { type: "text", text: `[Image omitted: unsupported type ${mimeType ?? "(none)"}]` };
	if (!clean || clean.length % 4 !== 0 || !BASE64.test(clean))
		return { type: "text", text: `[Image omitted: invalid base64 ${mime} data]` };
	return { type: "image", data: clean, mimeType: mime };
}

/**
 * Transform MCP content types to Pi content blocks.
 */
export function transformMcpContent(content: McpContent[]): ContentBlock[] {
	return content.map((c) => {
		if (c.type === "text") {
			return { type: "text" as const, text: c.text ?? "" };
		}
		if (c.type === "image") return imageBlock(c.data, c.mimeType);
		if (c.type === "resource") {
			const resourceUri = c.resource?.uri ?? "(no URI)";
			const resourceContent =
				c.resource?.text ?? (c.resource ? JSON.stringify(c.resource) : "(no content)");
			return {
				type: "text" as const,
				text: `[Resource: ${resourceUri}]\n${resourceContent}`,
			};
		}
		if (c.type === "resource_link") {
			const linkName = c.name ?? c.uri ?? "unknown";
			const linkUri = c.uri ?? "(no URI)";
			return {
				type: "text" as const,
				text: `[Resource Link: ${linkName}]\nURI: ${linkUri}`,
			};
		}
		if (c.type === "audio") {
			return {
				type: "text" as const,
				text: `[Audio content: ${c.mimeType ?? "audio/*"}]`,
			};
		}
		return { type: "text" as const, text: JSON.stringify(c) };
	});
}

/**
 * Resolve a tool result's content blocks, falling back to structuredContent
 * when content is empty.
 */
export function resolveMcpResultContent(result: Record<string, unknown>): ContentBlock[] {
	const blocks = transformMcpContent(
		(Array.isArray(result.content) ? result.content : []) as McpContent[],
	);
	if (blocks.length > 0) return blocks;

	if (result.structuredContent !== undefined && result.structuredContent !== null) {
		return [{ type: "text" as const, text: stringifyStructuredContent(result.structuredContent) }];
	}

	return [];
}

function stringifyStructuredContent(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}
