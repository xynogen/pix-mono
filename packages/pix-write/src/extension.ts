import {
	createWriteToolDefinition,
	createWriteTool as createWriteToolFallback,
	type ExtensionAPI,
	type WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { CursorStore, fffState } from "@xynogen/pix-pretty/fff";
import { attachResizeListener, trackInvalidator } from "@xynogen/pix-pretty/resize";
import type { PiPrettyApi, ToolFactory } from "@xynogen/pix-pretty/types";
import { linkedShortPath, viewportTextConstructor } from "@xynogen/pix-pretty/utils";

import { once } from "@xynogen/pix-runtime/once";
import { homeDir } from "@xynogen/pix-runtime/paths";
import { registerWriteTool } from "./write.ts";

export default function pixWriteExtension(pi: ExtensionAPI): void {
	const prettyPi = pi as unknown as PiPrettyApi;
	once(pi, "pix-write", () => {
		const createWriteTool = (createWriteToolDefinition ??
			createWriteToolFallback) as unknown as ToolFactory<WriteToolInput>;
		if (!createWriteTool) return;

		const cwd = process.cwd();
		const home = homeDir();

		attachResizeListener();

		registerWriteTool(
			prettyPi,
			createWriteTool,
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
