import {
	type BashToolInput,
	createBashToolDefinition,
	createBashTool as createBashToolFallback,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { CursorStore, fffState } from "@xynogen/pix-pretty/fff";
import type { PiPrettyApi, ToolFactory } from "@xynogen/pix-pretty/types";
import { linkedShortPath, viewportTextConstructor } from "@xynogen/pix-pretty/utils";
import { once } from "@xynogen/pix-runtime/once";
import { homeDir } from "@xynogen/pix-runtime/paths";
import { registerBashTool } from "./bash.ts";

export default function pixBashExtension(pi: ExtensionAPI): void {
	const prettyPi = pi as unknown as PiPrettyApi;
	once(pi, "pix-bash", () => {
		const createBashTool = (createBashToolDefinition ??
			createBashToolFallback) as unknown as ToolFactory<BashToolInput>;
		if (!createBashTool) return;

		const cwd = process.cwd();
		const home = homeDir();

		registerBashTool(prettyPi, createBashTool, {
			cwd,
			sp: (p: string) => linkedShortPath(cwd, home, p),
			TextComponent: viewportTextConstructor(Text),
			fffState,
			cursorStore: new CursorStore(),
		});
	});
}
