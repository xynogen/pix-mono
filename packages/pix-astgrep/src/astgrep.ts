/**
 * astgrep.ts — register the `ast` action tool.
 *
 * All actions share one lazy engine (see engine.ts). Registration starts no
 * process and loads no native addon. The addon loads on the first tool call.
 */

import { defineActionTool } from "@xynogen/pix-runtime/action-tool";
import type { ExtensionAPI } from "@xynogen/pix-runtime/host";
import { outlineTool } from "./tools/outline-tool.ts";
import { readEnclosingTool } from "./tools/read-enclosing-tool.ts";
import { readSymbolTool } from "./tools/read-symbol-tool.ts";
import { replaceTool } from "./tools/replace-tool.ts";
import { searchTool } from "./tools/search-tool.ts";
import { symbolSearchTool } from "./tools/symbol-search-tool.ts";

export function astTool(cwd = process.cwd()) {
	return defineActionTool({
		name: "ast",
		label: "AST",
		exposure: "deferred",
		description:
			"Syntax-aware code tools (ast-grep). Read structure and single symbols instead of whole files, and search or rewrite by AST pattern. Extra grammars require consent; newly installed grammars may need an agent restart.",
		promptSnippet:
			"ast(action, …) — outline|symbol|enclosing|search|replace|symbols: structural code read/search/rewrite",
		promptGuidelines: [
			'ast: to read code, "outline" a file first, then "symbol" (path, symbol) or "enclosing" (path, line) for one body instead of reading the whole file. "replace" previews by default; set apply:true only after the preview looks right. Load read_skills(name="pix-astgrep", full=true) for patterns.',
		],
		actions: {
			outline: { tool: outlineTool({ cwd }), summary: "path → top-level declarations with lines." },
			symbol: {
				tool: readSymbolTool({ cwd }),
				summary: "path, symbol → one declaration's source.",
			},
			enclosing: {
				tool: readEnclosingTool({ cwd }),
				summary: "path, line → smallest declaration covering that line.",
			},
			search: {
				tool: searchTool({ cwd }),
				summary: "pattern, paths?, lang?, limit? → structural matches.",
			},
			replace: {
				tool: replaceTool({ cwd }),
				summary: "pattern, rewrite, paths?, lang?, apply? → preview (default) or write.",
			},
			symbols: {
				tool: symbolSearchTool({ cwd }),
				summary: "query, paths?, limit? → files ranked by identifier hits.",
			},
		},
	});
}

export default function registerAstGrep(pi: ExtensionAPI): void {
	pi.registerTool(astTool());
}
