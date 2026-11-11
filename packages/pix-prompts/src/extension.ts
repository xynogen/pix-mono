import type { ExtensionAPI } from "@xynogen/pix-runtime/host";
import { once } from "@xynogen/pix-runtime/once";
import registerPrompts from "./prompts.ts";

export default function (pi: ExtensionAPI): void {
	once(pi, "pix-prompts", () => registerPrompts(pi));
}
