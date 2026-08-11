import {
	createWriteToolDefinition,
	createWriteTool as createWriteToolFallback,
	type WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import { CursorStore, fffState } from "@xynogen/pix-pretty/fff";
import { attachResizeListener, trackInvalidator } from "@xynogen/pix-pretty/resize";
import type { PiPrettyApi, TextComponentCtor, ToolFactory } from "@xynogen/pix-pretty/types";
import { shortPath, viewportTextConstructor } from "@xynogen/pix-pretty/utils";

import { once } from "@xynogen/pix-runtime/once";
import { registerWriteTool } from "./write.js";

export default function pixWriteExtension(pi: PiPrettyApi): void {
	once(pi, "pix-write", () => {
		const createWriteTool = (createWriteToolDefinition ??
			createWriteToolFallback) as unknown as ToolFactory<WriteToolInput>;
		if (!createWriteTool) return;

		let TextComponent: TextComponentCtor;
		try {
			TextComponent = require("@earendil-works/pi-tui").Text;
		} catch {
			return;
		}

		const cwd = process.cwd();
		const home = process.env.HOME ?? "";

		attachResizeListener();

		registerWriteTool(
			pi,
			createWriteTool,
			{
				cwd,
				sp: (p: string) => shortPath(cwd, home, p),
				TextComponent: viewportTextConstructor(TextComponent),
				fffState,
				cursorStore: new CursorStore(),
			},
			trackInvalidator,
		);
	});
}
