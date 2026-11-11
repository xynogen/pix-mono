import type { ExtensionAPI } from "@xynogen/pix-runtime/host";
import { once } from "@xynogen/pix-runtime/once";
import registerPixSubagent from "./index.ts";

export default function pixSubagentExtension(pi: ExtensionAPI): void {
	once(pi, "pix-subagent", () => {
		registerPixSubagent(pi);
	});
}
