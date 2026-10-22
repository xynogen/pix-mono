import {
	createLsToolDefinition,
	createLsTool as createLsToolFallback,
	type ExtensionAPI,
	type LsToolInput,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { CursorStore, fffState } from "@xynogen/pix-pretty/fff";
import type { PiPrettyApi, ToolFactory } from "@xynogen/pix-pretty/types";
import { linkedShortPath, viewportTextConstructor } from "@xynogen/pix-pretty/utils";
import { once } from "@xynogen/pix-runtime/once";
import { homeDir } from "@xynogen/pix-runtime/paths";
import { registerLsTool } from "./ls.ts";

export default function pixLsExtension(pi: ExtensionAPI): void {
	const prettyPi = pi as unknown as PiPrettyApi;
	once(pi, "pix-ls", () => {
		const createLsTool = (createLsToolDefinition ??
			createLsToolFallback) as unknown as ToolFactory<LsToolInput>;
		if (!createLsTool) return;

		const cwd = process.cwd();
		const home = homeDir();

		registerLsTool(prettyPi, createLsTool, {
			cwd,
			sp: (p: string) => linkedShortPath(cwd, home, p),
			TextComponent: viewportTextConstructor(Text),
			fffState,
			cursorStore: new CursorStore(),
		});
	});
}
