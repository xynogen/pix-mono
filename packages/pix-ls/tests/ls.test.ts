import { describe, expect, it } from "bun:test";
import {
	capturePi,
	makeRenderCtx,
	makeTheme,
	makeToolContext,
} from "@xynogen/pix-pretty/test-utils";
import type { ToolResultLike } from "@xynogen/pix-pretty/types";
import { applyLsDefaults, DEFAULT_LS_LIMIT, registerLsTool } from "../src/ls";

const noopFactory = () => ({ execute: async () => ({ content: [], details: undefined }) });

// Factory echoing one entry per requested directory path.
const echoFactory = (() => ({
	parameters: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
	execute: async (_id: string, params: { path?: string }) => ({
		content: [{ type: "text", text: `entry-in-${params.path}` }],
		details: undefined,
	}),
})) as unknown as typeof noopFactory;

describe("applyLsDefaults", () => {
	it("applies a conservative default without overriding an explicit limit", () => {
		expect(applyLsDefaults({})).toEqual({ limit: DEFAULT_LS_LIMIT });
		expect(applyLsDefaults({ path: "src", limit: 12 })).toEqual({ path: "src", limit: 12 });
	});
});

describe("registerLsTool", () => {
	it("registers a tool named 'ls'", () => {
		const { pi, names } = capturePi();
		registerLsTool(pi, noopFactory, makeToolContext());
		expect(names).toEqual(["ls"]);
	});

	it("lists multiple directories in one call and combines into a batch result", async () => {
		const { pi, tool } = capturePi();
		registerLsTool(pi, echoFactory, makeToolContext());
		const execute = tool.execute as (...args: unknown[]) => Promise<ToolResultLike>;
		const result = await execute("tid", { paths: ["src", "lib"] }, undefined, undefined, {});
		const d = result.details as { _type: string; paths?: string[]; entryCount: number };
		expect(d._type).toBe("lsResult");
		expect(d.paths).toEqual(["src", "lib"]);
		expect(d.entryCount).toBe(2);
		const text = result.content?.[0];
		const body = text && "text" in text ? text.text : "";
		expect(body).toContain("===== src =====");
		expect(body).toContain("entry-in-lib");
	});

	it("keeps the single-listing shape for one directory", async () => {
		const { pi, tool } = capturePi();
		registerLsTool(pi, echoFactory, makeToolContext());
		const execute = tool.execute as (...args: unknown[]) => Promise<ToolResultLike>;
		const result = await execute("tid", { path: "src" }, undefined, undefined, {});
		const d = result.details as { _type: string; path: string; paths?: string[] };
		expect(d._type).toBe("lsResult");
		expect(d.path).toBe("src");
		expect(d.paths).toBeUndefined();
	});

	it("restores the listing when an elapsed card is expanded", () => {
		const { pi, tool } = capturePi();
		registerLsTool(pi, noopFactory, makeToolContext());
		const result = tool.renderResult?.(
			{
				content: [{ type: "text", text: "alpha.ts\nbravo.ts" }],
				details: { _type: "lsResult", text: "alpha.ts\nbravo.ts", path: ".", entryCount: 2 },
			},
			undefined,
			makeTheme(),
			makeRenderCtx({ expanded: true, state: { collapsed: true } }),
		);

		expect(result?.getText()).toContain("alpha.ts");
		expect(result?.getText()).toContain("bravo.ts");
		expect(result?.getText()).not.toContain("✓ ls");
	});

	it("frames single-entry output like multi-entry (no inline row)", () => {
		const { pi, tool } = capturePi();
		registerLsTool(pi, noopFactory, makeToolContext());
		const theme = makeTheme();
		const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
		const result = {
			content: [{ type: "text", text: "README.md" }],
			details: { _type: "lsResult", text: "README.md", path: ".", entryCount: 1 },
		};
		const out =
			tool.renderResult?.(result, { isPartial: false }, theme, makeRenderCtx())?.getText() ?? "";
		// Single entry is now framed just like multi-entry — no inline row and no
		// floating "N entries" header; one shape regardless of count.
		expect(out).toContain("───");
		expect(out).toContain("README.md");
		expect(strip(out)).not.toContain("entries");
		const multi = {
			content: [{ type: "text", text: "a.ts\nb.ts\nc.ts" }],
			details: { _type: "lsResult", text: "a.ts\nb.ts\nc.ts", path: ".", entryCount: 3 },
		};
		const multiOut =
			tool.renderResult?.(multi, { isPartial: false }, theme, makeRenderCtx())?.getText() ?? "";
		expect(multiOut).toContain("───");
	});

	it("collapses structured errors and restores the exact diagnostic on expansion", () => {
		const { pi, tool } = capturePi();
		registerLsTool(pi, noopFactory, makeToolContext());
		const theme = makeTheme();
		const diagnostic = "ENOENT: cannot list missing-dir";
		const result = {
			content: [{ type: "text", text: diagnostic }],
			details: { _type: "lsResult", text: diagnostic, path: "missing-dir", entryCount: 0 },
		};
		const render = (state: Record<string, unknown>, expanded = false) => {
			const component = tool.renderResult?.(
				result,
				{ isPartial: false },
				theme,
				makeRenderCtx({ isError: true, expanded, state }),
			);
			return component?.render(120).join("\n") ?? "";
		};

		expect(render({ timer: 1 })).toContain(diagnostic);
		expect(render({ timer: 1 })).toContain("───");
		expect(render({ collapsed: true })).toContain("✗  ls missing-dir · failed");
		expect(render({ collapsed: true }, true)).toContain(diagnostic);
	});
});
