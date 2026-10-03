import {
	createEditToolDefinition,
	createEditTool as createEditToolFallback,
	type EditToolInput,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { CursorStore, fffState } from "@xynogen/pix-pretty/fff";
import { attachResizeListener, trackInvalidator } from "@xynogen/pix-pretty/resize";
import type { PiPrettyApi, ToolFactory } from "@xynogen/pix-pretty/types";
import { shortPath, viewportTextConstructor } from "@xynogen/pix-pretty/utils";
import { initHashline } from "@xynogen/pix-runtime/hashline";
import { once } from "@xynogen/pix-runtime/once";
import { homeDir } from "@xynogen/pix-runtime/paths";
import { registerEditTool } from "./edit.ts";

export default async function pixEditExtension(pi: ExtensionAPI): Promise<void> {
	await initHashline();
	const prettyPi = pi as unknown as PiPrettyApi;
	once(pi, "pix-edit", () => {
		const createEditTool = (createEditToolDefinition ??
			createEditToolFallback) as unknown as ToolFactory<EditToolInput>;
		if (!createEditTool) return;

		const cwd = process.cwd();
		const home = homeDir();

		attachResizeListener();

		registerEditTool(
			prettyPi,
			createEditTool,
			{
				cwd,
				sp: (p: string) => shortPath(cwd, home, p),
				TextComponent: viewportTextConstructor(Text),
				fffState,
				cursorStore: new CursorStore(),
			},
			trackInvalidator,
		);
	});
}
