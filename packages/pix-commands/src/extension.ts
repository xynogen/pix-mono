import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { once } from "@xynogen/pix-runtime/once";
import { registerBtw } from "./btw/index.ts";
import registerClear from "./clear.ts";
import registerUnattended from "./unattended.ts";

export default function (pi: ExtensionAPI): void {
	once(pi, "pix-commands", () => {
		registerClear(pi);
		registerBtw(pi);
		registerUnattended(pi);
	});
}
