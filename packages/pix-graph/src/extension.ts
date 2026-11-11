import type { ExtensionAPI } from "@xynogen/pix-runtime/host";
import registerGraph from "./graph.ts";

export default function pixGraphExtension(pi: ExtensionAPI): void {
	registerGraph(pi);
}
