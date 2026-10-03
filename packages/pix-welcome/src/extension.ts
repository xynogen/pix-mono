import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { once } from "@xynogen/pix-runtime/once";
import { patchQuietStartup } from "./quiet-startup.ts";
import registerWelcome from "./welcome.ts";

export default function (pi: ExtensionAPI): void {
	once(pi, "pix-welcome", () => {
		// The pix banner replaces Pi's startup header. Keep that for the next load.
		try {
			patchQuietStartup();
		} catch (error) {
			console.warn(`pix-welcome: could not set quietStartup: ${(error as Error).message}`);
		}
		registerWelcome(pi);
	});
}
