import type { ExtensionAPI } from "@xynogen/pix-runtime/host";
import { once } from "@xynogen/pix-runtime/once";
import registerFooter from "./footer.ts";

export default function (pi: ExtensionAPI): void {
	once(pi, "pix-footer", () => registerFooter(pi));
}
