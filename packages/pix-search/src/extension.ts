import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSearchProvider } from "./provider.ts";
import { loadRecency, type RecencyMap } from "./recency.ts";

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		const cwd = ctx.cwd;

		// Warm recency cache in background — non-blocking
		let recency: RecencyMap = new Map();
		const recencyReady = loadRecency(cwd).then((map) => {
			recency = map;
		});
		// Fire-and-forget; if git isn't available, recency stays empty
		void recencyReady;

		ctx.ui.addAutocompleteProvider((current) => createSearchProvider(current, cwd, () => recency));
	});
}
