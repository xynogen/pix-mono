/**
 * Keep the prompt lean: only the always-on tools are declared up front. Every other
 * `direct` tool a bundled member registers becomes `deferred`, and `tool_search`
 * is activated so the model can find and load them on demand.
 *
 * It patches `registerTool` on pix-core's own `pi` object. Pi gives each
 * extension its own API object, so tools of standalone installs and other
 * extensions keep their declared exposure.
 */

import type { ExtensionAPI, ToolInfo } from "@xynogen/pix-runtime/host";

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

	// Pi's tool_search ranks with BM25 and no source weighting, so a generic query ("search file
	// contents") fills slots with server tools whose descriptions share a word. Ask it for a
	// wider pool, re-rank with an MCP penalty, then unload what falls past the requested limit.
	const requested = new Map<string, number>();
	pi.on("tool_call", (event) => {
		if (event.toolName !== "tool_search") return;
		const limit = Number(event.input.limit ?? DEFAULT_LIMIT);
		if (!Number.isInteger(limit) || limit <= 0) return; // let tool_search report it
		requested.set(event.toolCallId, limit);
		event.input.limit = limit * POOL_FACTOR;
	});

	pi.on("tool_result", (event) => {
		if (event.toolName !== "tool_search") return;
		const limit = requested.get(event.toolCallId);
		requested.delete(event.toolCallId);
		if (limit === undefined || event.isError) return;
		const loaded = (event.details as { loaded?: string[] } | undefined)?.loaded ?? [];
		const query = String(event.input.query ?? "");
		const tools = pi.getAllTools();
		const kept = weightNative(loaded, tools, query).slice(0, limit);
		const keep = new Set(kept);
		const dropped = loaded.filter((n) => !keep.has(n));
		if (dropped.length) pi.setActiveTools(pi.getActiveTools().filter((n) => !dropped.includes(n)));

		const lines = event.content.flatMap((c) => (c.type === "text" ? c.text.split("\n") : []));
		const row = new Map(
			lines.flatMap((l) => {
				const name = /^- ([^:]+):/.exec(l)?.[1];
				return name ? [[name, l] as const] : [];
			}),
		);
		const demoted = kept.length ? loaded.slice(0, limit).filter((n) => !keep.has(n)) : [];
		const text = kept.length
			? [
					`Loaded ${kept.length} tool${kept.length === 1 ? "" : "s"}. They are available from your next call:`,
					...kept.map((n) => row.get(n) ?? `- ${n}`),
					...(demoted.length
						? [
								`Ranked below native tools: ${demoted.join(", ")}. Name the server in the query to load them.`,
							]
						: []),
				].join("\n")
			: "No matching tools found.";
		return {
			content: [{ type: "text" as const, text }],
			details: { ...(event.details as object), loaded: kept, demoted },
		};
	});
}

/** Pi's `DEFAULT_TOOL_SEARCH_LIMIT`; not exported from the package root. */
const DEFAULT_LIMIT = 8;
/** Pool size, as a multiple of the requested limit, that the re-rank chooses from. */
const POOL_FACTOR = 3;
// ponytail: one fixed penalty, in rank positions. 8 lifted the native tool into the top 8 on
// every probe query of this session (grep, ast, find, read_env, lsp) and
// left server-specific queries ("kicad footprint", "browser click") unchanged.
const MCP_PENALTY = 8;

const isMcp = (t: ToolInfo | undefined): boolean =>
	!!t && (t.name.startsWith("mcp__") || /mcp/i.test(t.sourceInfo?.source ?? ""));

/** Server name of an MCP tool: its namespace, else the `mcp__<server>__tool` segment. */
const serverOf = (t: ToolInfo): string =>
	(t.namespace?.name.replace(/^mcp__/, "") ?? t.name.split("__")[1] ?? "").toLowerCase();

/**
 * Re-rank tool_search hits: an MCP tool whose server the query does not name drops
 * `MCP_PENALTY` positions, so a native tool with a slightly lower BM25 rank wins. Once the
 * pool holds a native tool, such MCP hits ranked below the first native one are dropped:
 * they only share a word with the query, and a short list beats loading unused schemas.
 * A query that names a server keeps that server's order. Stable for ties.
 */
export function weightNative(ranked: string[], tools: ToolInfo[], query: string): string[] {
	const byName = new Map(tools.map((t) => [t.name, t]));
	const terms = new Set(
		query
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter(Boolean),
	);
	const hits = ranked.map((name, rank) => {
		const t = byName.get(name);
		const mcp = t !== undefined && isMcp(t);
		return { name, rank, mcp, penal: mcp && !terms.has(serverOf(t)) };
	});
	const firstNative = hits.find((h) => !h.mcp)?.rank ?? Number.POSITIVE_INFINITY;
	return hits
		.filter((h) => !h.penal || h.rank < firstNative)
		.map((h) => ({ ...h, weighted: h.rank + (h.penal ? MCP_PENALTY : 0) }))
		.sort((a, b) => a.weighted - b.weighted || a.rank - b.rank)
		.map((h) => h.name);
}
