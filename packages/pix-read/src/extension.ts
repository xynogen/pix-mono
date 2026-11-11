import { CursorStore, fffState } from "@xynogen/pix-pretty/fff";
import { Text } from "@xynogen/pix-pretty/tui";
import { linkedShortPath, viewportTextConstructor } from "@xynogen/pix-pretty/utils";
import { initHashline } from "@xynogen/pix-runtime/hashline";
import {
	createReadToolDefinition,
	createReadTool as createReadToolFallback,
	type ExtensionAPI,
} from "@xynogen/pix-runtime/host";
import { once } from "@xynogen/pix-runtime/once";
import { homeDir } from "@xynogen/pix-runtime/paths";
import { registerReadTool } from "./read.ts";

export default async function pixReadExtension(pi: ExtensionAPI): Promise<void> {
	await initHashline();
	once(pi, "pix-read", () => {
		const createReadTool = createReadToolDefinition ?? createReadToolFallback;
		if (!createReadTool) return;

		const cwd = process.cwd();
		const home = homeDir();

		registerReadTool(pi, createReadTool, {
			cwd,
			sp: (p: string) => linkedShortPath(cwd, home, p),
			TextComponent: viewportTextConstructor(Text),
			fffState,
			cursorStore: new CursorStore(),
		});
	});
}
