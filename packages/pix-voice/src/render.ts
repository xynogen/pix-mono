/**
 * render.ts — fetch/search results as dim text.
 *
 * fetch/search return external web content the model already consumed; the full body is noise
 * in the transcript. It renders dim (theme `dim`) so it reads like faded reasoning — present for
 * inspection, visually quiet — with the tool title line kept normal so calls stay scannable.
 */

import { type BodyCardSpec, bodyCardRenderer } from "@xynogen/pix-pretty/tool-card";
import { Text } from "@xynogen/pix-pretty/tui";

export type { BodyCardSpec as CompactRendererConfig };

/** Build a `renderResult` with a bounded dim preview and optional compact terminal row. */
export function makeRenderResult<TDetails>(config?: BodyCardSpec<TDetails>) {
	// Preview cap is intentionally generous — dimming already de-emphasises the body, so we only
	// truncate to keep pathological multi-thousand-line dumps from flooding the viewport.
	return bodyCardRenderer(Text, { ...config, tool: config?.tool ?? "", maxPreviewLines: 32 });
}
