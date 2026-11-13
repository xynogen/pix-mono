/** Render web results as Markdown in the transcript without changing model content. */

import { type BodyCardSpec, bodyCardRenderer } from "@xynogen/pix-pretty/tool-card";
import { Text } from "@xynogen/pix-pretty/tui";

export type { BodyCardSpec as CompactRendererConfig };

/** Build a `renderResult` with a Markdown body whose tail fades, plus a compact terminal row. */
export function makeRenderResult<TDetails>(config?: BodyCardSpec<TDetails>) {
	// Preview budget in rendered rows; the last few fade out. Expand shows the full page.
	return bodyCardRenderer(Text, {
		...config,
		tool: config?.tool ?? "",
		maxPreviewLines: 16,
		markdown: true,
	});
}
