/**
 * astgrep.ts — register the three structural-code tools.
 *
 * All three share one lazy engine (see engine.ts). Registration starts no
 * process and loads no native addon. The addon loads on the first tool call.
 */

import type { ExtensionAPI } from "@xynogen/pix-runtime/host";
import { registerOutlineTool } from "./tools/outline-tool.ts";
import { registerReadEnclosingTool } from "./tools/read-enclosing-tool.ts";
import { registerReadSymbolTool } from "./tools/read-symbol-tool.ts";
import { registerReplaceTool } from "./tools/replace-tool.ts";
import { registerSearchTool } from "./tools/search-tool.ts";
import { registerSymbolSearchTool } from "./tools/symbol-search-tool.ts";

export default function registerAstGrep(pi: ExtensionAPI): void {
	const cwd = process.cwd();
	registerSearchTool(pi, { cwd });
	registerReplaceTool(pi, { cwd });
	registerOutlineTool(pi, { cwd });
	registerReadSymbolTool(pi, { cwd });
	registerReadEnclosingTool(pi, { cwd });
	registerSymbolSearchTool(pi, { cwd });
}
