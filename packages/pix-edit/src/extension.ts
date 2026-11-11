import { CursorStore, fffState } from "@xynogen/pix-pretty/fff";
import { attachResizeListener, trackInvalidator } from "@xynogen/pix-pretty/resize";
import { Text } from "@xynogen/pix-pretty/tui";
import { linkedShortPath, viewportTextConstructor } from "@xynogen/pix-pretty/utils";
import { initHashline } from "@xynogen/pix-runtime/hashline";
import {
	createEditToolDefinition,
	createEditTool as createEditToolFallback,
	type ExtensionAPI,
} from "@xynogen/pix-runtime/host";
import { once } from "@xynogen/pix-runtime/once";
import { homeDir } from "@xynogen/pix-runtime/paths";
import { registerEditTool } from "./edit.ts";

export default async function pixEditExtension(pi: ExtensionAPI): Promise<void> {
	await initHashline();
	once(pi, "pix-edit", () => {
		const createEditTool = createEditToolDefinition ?? createEditToolFallback;
		if (!createEditTool) return;

		const cwd = process.cwd();
		const home = homeDir();

		attachResizeListener();

		registerEditTool(
			pi,
			createEditTool,
			{
				cwd,
				sp: (p: string) => linkedShortPath(cwd, home, p),
				TextComponent: viewportTextConstructor(Text),
				fffState,
				cursorStore: new CursorStore(),
			},
			trackInvalidator,
		);
	});
}
