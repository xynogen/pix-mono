import { describe, expect, it } from "bun:test";
import {
	capturePi,
	makeRenderCtx,
	makeTheme,
	makeToolContext,
} from "@xynogen/pix-pretty/test-utils";
import { applyLsDefaults, DEFAULT_LS_LIMIT, registerLsTool } from "./ls";

const noopFactory = () => ({ execute: async () => ({ content: [], details: undefined }) });

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
		expect(out).toContain("─");
		expect(out).toContain("README.md");
		expect(strip(out)).not.toContain("entries");
		const multi = {
			content: [{ type: "text", text: "a.ts\nb.ts\nc.ts" }],
			details: { _type: "lsResult", text: "a.ts\nb.ts\nc.ts", path: ".", entryCount: 3 },
		};
		const multiOut =
			tool.renderResult?.(multi, { isPartial: false }, theme, makeRenderCtx())?.getText() ?? "";
		expect(multiOut).toContain("─");
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
		expect(render({ timer: 1 })).toContain("─");
		expect(render({ collapsed: true })).toContain("✗  ls missing-dir · failed");
		expect(render({ collapsed: true }, true)).toContain(diagnostic);
	});
});
