import { CursorStore, fffState } from "@xynogen/pix-pretty/fff";
import { Text } from "@xynogen/pix-pretty/tui";
import { linkedShortPath, viewportTextConstructor } from "@xynogen/pix-pretty/utils";
import {
	createBashToolDefinition,
	createBashTool as createBashToolFallback,
	type ExtensionAPI,
} from "@xynogen/pix-runtime/host";
import { once } from "@xynogen/pix-runtime/once";
import { homeDir } from "@xynogen/pix-runtime/paths";
import { registerBashTool } from "./bash.ts";

export default function pixBashExtension(pi: ExtensionAPI): void {
	once(pi, "pix-bash", () => {
		const createBashTool = createBashToolDefinition ?? createBashToolFallback;
		if (!createBashTool) return;

		const cwd = process.cwd();
		const home = homeDir();

		registerBashTool(pi, createBashTool, {
			cwd,
			sp: (p: string) => linkedShortPath(cwd, home, p),
			TextComponent: viewportTextConstructor(Text),
			fffState,
			cursorStore: new CursorStore(),
		});
	});
}
