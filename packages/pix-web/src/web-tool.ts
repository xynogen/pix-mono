import { defineActionTool } from "@xynogen/pix-runtime/action-tool";
import type { ExtensionAPI } from "@xynogen/pix-runtime/host";
import { searchTool } from "./search-tool.ts";
import { fetchTool } from "./tools.ts";

export function webTool() {
	return defineActionTool({
		name: "web",
		label: "Web",
		description:
			'Web access through the configured providers. action "search" finds pages; action "fetch" reads one URL as plain text.',
		promptSnippet: 'web(action: "search"|"fetch", …) — web search and page fetch',
		promptGuidelines: [
			'web: search first (action "search", query), then fetch the best URLs (action "fetch", url). Keep fetch max_characters small (default 1000) and raise it only for the page you need. Load read_skills(name="pix-web", full=true) for patterns.',
		],
		actions: {
			search: { tool: searchTool(), summary: "query, search_type?, max_results?" },
			fetch: { tool: fetchTool(), summary: "url, format?, max_characters?" },
		},
	});
}

export function registerWebTool(pi: ExtensionAPI): void {
	pi.registerTool(webTool());
}
