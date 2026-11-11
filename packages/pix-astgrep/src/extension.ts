import type { ExtensionAPI } from "@xynogen/pix-runtime/host";
import { once } from "@xynogen/pix-runtime/once";
import registerAstGrep from "./astgrep.ts";

export default function (pi: ExtensionAPI): void {
	once(pi, "pix-astgrep", () => registerAstGrep(pi));
}
