/**
 * Keep the prompt lean: only the always-on tools are declared up front. Every other
 * `direct` tool a bundled member registers becomes `deferred`, and `tool_search`
 * is activated so the model can find and load them on demand.
 *
 * It patches `registerTool` on pix-core's own `pi` object. Pi gives each
 * extension its own API object, so tools of standalone installs and other
 * extensions keep their declared exposure.
 */

import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";

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
	// PowerShell registers only on Windows and stays enabled there, like the default shell.
	pi.registerTool = (tool) =>
		register(
			tool.name === "powershell" ||
				ALWAYS_ON_TOOLS.has(tool.name) ||
				(tool.exposure ?? "direct") !== "direct"
				? tool
				: { ...tool, exposure: "deferred" },
		);

	pi.on("session_start", () => {
		const active = pi.getActiveTools();
		const registered = new Set(pi.getAllTools().map((t) => t.name));
		const missing = ACTIVATE_ON_START.filter((n) => registered.has(n) && !active.includes(n));
		if (missing.length) pi.setActiveTools([...active, ...missing]);
	});

	pi.on("tool_result", (event) => {
		if (event.toolName !== "tool_search" || event.isError) return;
		const loaded = (event.details as { loaded?: string[] } | undefined)?.loaded ?? [];
		const query = String(event.input.query ?? "");
		const drop = demotedMcp(loaded, pi.getAllTools(), query);
		if (drop.length === 0) return;
		const gone = new Set(drop);
		pi.setActiveTools(pi.getActiveTools().filter((n) => !gone.has(n)));
		const kept = loaded.filter((n) => !gone.has(n));
		const lines = event.content.flatMap((c) => (c.type === "text" ? c.text.split("\n") : []));
		const rows = lines.filter((l) => !gone.has(/^- ([^:]+):/.exec(l)?.[1] ?? ""));
		rows[0] = `Loaded ${kept.length} tool${kept.length === 1 ? "" : "s"}. They are available from your next call:`;
		rows.push(
			`Skipped ${drop.length} MCP tool(s) ranked below native matches: ${drop.join(", ")}. Name the server in the query to load them.`,
		);
		return {
			content: [{ type: "text" as const, text: rows.join("\n") }],
			details: { ...(event.details as object), loaded: kept, skipped: drop },
		};
	});
}

const isMcp = (t: ToolInfo | undefined): boolean =>
	!!t && (t.name.startsWith("mcp__") || /mcp/i.test(t.sourceInfo?.source ?? ""));

/** Server name of an MCP tool: its namespace, else the `mcp__<server>__tool` segment. */
const serverOf = (t: ToolInfo): string =>
	(t.namespace?.name ?? t.name.split("__")[1] ?? "").toLowerCase();

/**
 * MCP hits that tool_search ranked below the first native hit, unless the query names their
 * server. MCP tools that outrank every native tool stay: they are the real answer. Pi's BM25
 * ranker has no source weighting, so a generic query ("search file contents") otherwise loads
 * unrelated server tools whose descriptions share a word.
 */
export function demotedMcp(loaded: string[], tools: ToolInfo[], query: string): string[] {
	const byName = new Map(tools.map((t) => [t.name, t]));
	const firstNative = loaded.findIndex((n) => byName.has(n) && !isMcp(byName.get(n)));
	if (firstNative < 0) return [];
	const terms = new Set(
		query
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter(Boolean),
	);
	return loaded.slice(firstNative + 1).filter((n) => {
		const t = byName.get(n);
		return t !== undefined && isMcp(t) && !terms.has(serverOf(t));
	});
}
