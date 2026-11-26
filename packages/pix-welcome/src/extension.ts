import type { ExtensionAPI } from "@xynogen/pix-runtime/host";
import { once } from "@xynogen/pix-runtime/once";
import { setPiSettings } from "@xynogen/pix-runtime/pi-settings";
import registerWelcome from "./welcome.ts";

export default function (pi: ExtensionAPI): void {
	once(pi, "pix-welcome", () => {
		// The pix banner replaces Pi's startup header. Keep that for the next load.
		try {
			// An explicit user value wins; Pi reads quietStartup before extensions run.
			setPiSettings({ quietStartup: true }, { onlyMissing: true });
		} catch (error) {
			console.warn(`pix-welcome: could not set quietStartup: ${(error as Error).message}`);
		}
		registerWelcome(pi);
	});
}
