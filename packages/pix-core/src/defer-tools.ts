/**
 * Keep the prompt lean: only the always-on tools are declared up front. Every other
 * `direct` tool a bundled member registers becomes `deferred`, and `tool_search`
 * is activated so the model can find and load them on demand.
 *
 * It patches `registerTool` on pix-core's own `pi` object. Pi gives each
 * extension its own API object, so tools of standalone installs and other
 * extensions keep their declared exposure.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Always-on tools. Keep in sync with pix-toolbox `ALWAYS_ON_TOOLS`.
export const ALWAYS_ON_TOOLS: ReadonlySet<string> = new Set([
	"read",
	"bash",
	"edit",
	"write",
	"tool_search",
	"codemode",
]);
// Pi registers these inactive. Without them, deferred tools are unreachable.
const ACTIVATE_ON_START = ["tool_search", "codemode"];

export default function deferNonCoreTools(pi: ExtensionAPI): void {
	const register = pi.registerTool.bind(pi);
	pi.registerTool = (tool) =>
		register(
			ALWAYS_ON_TOOLS.has(tool.name) || (tool.exposure ?? "direct") !== "direct"
				? tool
				: { ...tool, exposure: "deferred" },
		);

	pi.on("session_start", () => {
		const active = pi.getActiveTools();
		const registered = new Set(pi.getAllTools().map((t) => t.name));
		const missing = ACTIVATE_ON_START.filter((n) => registered.has(n) && !active.includes(n));
		if (missing.length) pi.setActiveTools([...active, ...missing]);
	});
}
