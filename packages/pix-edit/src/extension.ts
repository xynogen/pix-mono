import {
	createEditToolDefinition,
	createEditTool as createEditToolFallback,
	type EditToolInput,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { CursorStore, fffState } from "@xynogen/pix-pretty/fff";
import { attachResizeListener, trackInvalidator } from "@xynogen/pix-pretty/resize";
import type { PiPrettyApi, TextComponentCtor, ToolFactory } from "@xynogen/pix-pretty/types";
import { shortPath, viewportTextConstructor } from "@xynogen/pix-pretty/utils";
import { once } from "@xynogen/pix-runtime/once";
import { registerEditTool } from "./edit.js";

export default function pixEditExtension(pi: ExtensionAPI): void {
	const prettyPi = pi as unknown as PiPrettyApi;
	once(pi, "pix-edit", () => {
		const createEditTool = (createEditToolDefinition ??
			createEditToolFallback) as unknown as ToolFactory<EditToolInput>;
		if (!createEditTool) return;

		let TextComponent: TextComponentCtor;
		try {
			TextComponent = require("@earendil-works/pi-tui").Text;
		} catch {
			return;
		}

		const cwd = process.cwd();
		const home = process.env.HOME ?? "";

		attachResizeListener();

		registerEditTool(
			prettyPi,
			createEditTool,
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
