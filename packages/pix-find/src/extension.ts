import { CursorStore, fffState } from "@xynogen/pix-pretty/fff";
import { Text } from "@xynogen/pix-pretty/tui";
import { linkedShortPath, viewportTextConstructor } from "@xynogen/pix-pretty/utils";
import {
	createFindToolDefinition,
	createFindTool as createFindToolFallback,
	type ExtensionAPI,
} from "@xynogen/pix-runtime/host";
import { once } from "@xynogen/pix-runtime/once";
import { homeDir } from "@xynogen/pix-runtime/paths";
import { registerFindTool } from "./find.ts";

export default function pixFindExtension(pi: ExtensionAPI): void {
	once(pi, "pix-find", () => {
		const createFindTool = createFindToolDefinition ?? createFindToolFallback;
		if (!createFindTool) return;

		const cwd = process.cwd();
		const home = homeDir();

		registerFindTool(pi, createFindTool, {
			cwd,
			sp: (p: string) => linkedShortPath(cwd, home, p),
			TextComponent: viewportTextConstructor(Text),
			fffState,
			cursorStore: new CursorStore(),
		});
	});
}
