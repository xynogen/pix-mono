import { describe, expect, it } from "bun:test";
import { resolveMcpResultContent } from "../src/tool-registrar.ts";

describe("MCP image blocks", () => {
	it("keeps a valid image and replaces an unsafe one with a text note", () => {
		const blocks = resolveMcpResultContent({
			content: [
				{ type: "image", data: "iVBORw0K\nGgo=", mimeType: "IMAGE/PNG" },
				{ type: "image", data: "PHN2Zz4=", mimeType: "image/svg+xml" },
				{ type: "image", data: "not base64!", mimeType: "image/jpeg" },
				{ type: "image", mimeType: "image/webp" },
			],
		});
		expect(blocks[0]).toEqual({ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" });
		expect(blocks.slice(1).map((b) => b.type)).toEqual(["text", "text", "text"]);
		expect(blocks.slice(1).map((b) => (b as { text: string }).text)).toEqual([
			expect.stringMatching(/^\[Image omitted: unsupported type image\/svg\+xml\]$/),
			expect.stringMatching(/^\[Image omitted: invalid base64 image\/jpeg data\]$/),
			expect.stringMatching(/^\[Image omitted: invalid base64 image\/webp data\]$/),
		]);
	});
});

describe("resolveMcpResultContent", () => {
	it("returns transformed content blocks when content is present", () => {
		const blocks = resolveMcpResultContent({
			content: [{ type: "text", text: "hello" }],
			structuredContent: { ignored: true },
		});

		expect(blocks).toEqual([{ type: "text", text: "hello" }]);
	});

	it("falls back to structuredContent when content is empty", () => {
		const structured = { status: "available", summary: "## Notes" };
		const blocks = resolveMcpResultContent({
			content: [],
			structuredContent: structured,
		});

		expect(blocks).toEqual([{ type: "text", text: JSON.stringify(structured, null, 2) }]);
	});

	it("falls back to structuredContent when content is omitted entirely", () => {
		const structured = { value: 42 };
		const blocks = resolveMcpResultContent({ structuredContent: structured });

		expect(blocks).toEqual([{ type: "text", text: JSON.stringify(structured, null, 2) }]);
	});

	it("returns empty array when both content and structuredContent are absent", () => {
		expect(resolveMcpResultContent({ content: [] })).toEqual([]);
		expect(resolveMcpResultContent({})).toEqual([]);
	});

	it("does not treat null structuredContent as a fallback payload", () => {
		expect(resolveMcpResultContent({ content: [], structuredContent: null })).toEqual([]);
	});

	it("treats an empty structuredContent object as a present payload", () => {
		// guards against a truthy check that would drop a legitimately empty object
		expect(resolveMcpResultContent({ content: [], structuredContent: {} })).toEqual([
			{ type: "text", text: "{}" },
		]);
	});

	it("does not fall back when content has a non-text block", () => {
		const blocks = resolveMcpResultContent({
			content: [{ type: "image", data: "abcd", mimeType: "image/png" }],
			structuredContent: { should: "not appear" },
		});

		expect(blocks).toEqual([{ type: "image", data: "abcd", mimeType: "image/png" }]);
	});

	it("degrades gracefully when structuredContent is not serializable", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;

		const blocks = resolveMcpResultContent({ content: [], structuredContent: circular });

		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({ type: "text" });
	});

	it("prefers real content over structuredContent even for a single block", () => {
		const blocks = resolveMcpResultContent({
			content: [{ type: "text", text: "real" }],
			structuredContent: { fallback: "should not appear" },
		});

		expect(blocks).toEqual([{ type: "text", text: "real" }]);
	});
});
