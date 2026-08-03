/**
 * mcp-panel-kitty-keys.test.ts — printable-key dispatch under the Kitty
 * keyboard protocol.
 *
 * Under Kitty flag 1 (disambiguate), plain characters arrive as CSI-u escape
 * sequences (`ESC [ <codepoint> u`), not single bytes. These tests assert the
 * panel's letter shortcuts and type-to-search accept BOTH encodings, and that
 * modified letters (shift+…) are not mistaken for their plain forms.
 */

import { describe, expect, it, mock } from "bun:test";
import { createMcpPanel } from "../src/mcp-panel.ts";
import { computeServerHash, type MetadataCache } from "../src/metadata-cache.ts";
import type { McpConfig, McpPanelCallbacks } from "../src/types.ts";

// CSI-u form: ESC [ <codepoint> u
const kitty = (ch: string): string => `\u001b[${ch.codePointAt(0)}u`;

const ENCODINGS = [
	{ name: "legacy", enc: (ch: string) => ch },
	{ name: "kitty", enc: kitty },
] as const;

function createConfig(): McpConfig {
	return {
		mcpServers: {
			alpha: { url: "https://alpha.example.com/mcp" },
			bravo: { url: "https://bravo.example.com/mcp" },
		},
	};
}

/** Cached tools so servers stay visible under name search and can be dirtied. */
function createCache(config: McpConfig): MetadataCache {
	const entry = (name: string) => ({
		configHash: computeServerHash(config.mcpServers[name]!),
		cachedAt: Date.now(),
		tools: [{ name: `${name}_tool`, description: `${name} tool` }],
		resources: [],
	});
	return { version: 1, servers: { alpha: entry("alpha"), bravo: entry("bravo") } };
}

function createCallbacks(): McpPanelCallbacks {
	return {
		reconnect: async () => true,
		canAuthenticate: () => false,
		authenticate: mock(async () => ({ ok: true })),
		getConnectionStatus: () => "connected",
		refreshCacheAfterReconnect: () => null,
	};
}

function openPanel(onDone: (r: unknown) => void = () => {}) {
	const config = createConfig();
	return createMcpPanel(
		config,
		createCache(config),
		new Map(),
		createCallbacks(),
		{ requestRender: () => {} },
		onDone,
		{},
	);
}

/** Expand the first server and toggle its first tool → dirty panel. */
function makeDirty(panel: ReturnType<typeof openPanel>): void {
	panel.handleInput("\r"); // expand alpha
	panel.handleInput("\u001b[B"); // down to alpha_tool
	panel.handleInput("\r"); // toggle direct → dirty
}

const plain = (lines: string[]): string => lines.join("\n").replace(/\u001b\[[0-9;]*m/g, "");

for (const { name, enc } of ENCODINGS) {
	describe(`mcp-panel printable keys (${name} encoding)`, () => {
		it("typed characters land in the name-search query", () => {
			const panel = openPanel();
			panel.handleInput(enc("a"));
			panel.handleInput(enc("l"));
			const text = plain(panel.render(100));
			// The query line shows what was typed (cursor char follows it).
			expect(text).toContain("al│");
			// The matching server is highlighted with the selected-row marker.
			expect(text).toMatch(/▶.*alpha/);
			expect(text).not.toMatch(/▶.*bravo/);
			panel.dispose();
		});

		it("? opens description search", () => {
			const panel = openPanel();
			panel.handleInput(enc("?"));
			const text = plain(panel.render(100));
			expect(text.toLowerCase()).toContain("desc");
			panel.dispose();
		});

		it("y confirms the discard dialog (cancelled result)", async () => {
			let result: { cancelled?: boolean } | undefined;
			const panel = openPanel((r) => {
				result = r as { cancelled?: boolean };
			});
			makeDirty(panel);
			panel.handleInput("\u001b"); // escape → discard confirm dialog
			panel.handleInput(enc("y")); // confirm discard
			await Promise.resolve();
			expect(result).toBeDefined();
			expect(result?.cancelled).toBe(true);
			panel.dispose();
		});

		it("n dismisses the discard dialog (panel stays open)", () => {
			let done = false;
			const panel = openPanel(() => {
				done = true;
			});
			makeDirty(panel);
			panel.handleInput("\u001b"); // escape → discard confirm dialog
			panel.handleInput(enc("n")); // back to panel
			expect(done).toBe(false);
			panel.dispose();
		});
	});
}

describe("mcp-panel printable keys (guards)", () => {
	it("ctrl-modified letters do not enter the search query", () => {
		const panel = openPanel();
		panel.handleInput("\u001b[97;5u"); // ctrl+a in CSI-u form
		const text = plain(panel.render(100));
		// Both servers still visible — 'a' was NOT appended to nameQuery.
		expect(text).toContain("alpha");
		expect(text).toContain("bravo");
		panel.dispose();
	});

	it.each([
		["legacy DEL", "\u007f"],
		["Kitty DEL", "\u001b[127u"],
		["legacy C1 NEL", "\u0085"],
		["Kitty C1 NEL", "\u001b[133u"],
	])("%s is not treated as a printable character", (_name, input) => {
		const panel = openPanel();
		panel.handleInput(input);
		const text = plain(panel.render(100));
		// No filter query was added — both servers remain ordinary rows.
		expect(text).toContain("alpha");
		expect(text).toContain("bravo");
		panel.dispose();
	});
});
