import {
	type BashToolInput,
	createBashToolDefinition,
	createBashTool as createBashToolFallback,
} from "@earendil-works/pi-coding-agent";
import { CursorStore, fffState } from "@xynogen/pix-pretty/fff";
import type { PiPrettyApi, TextComponentCtor, ToolFactory } from "@xynogen/pix-pretty/types";
import { shortPath, viewportTextConstructor } from "@xynogen/pix-pretty/utils";
import { once } from "@xynogen/pix-runtime/once";
import { registerBashTool } from "./bash.js";

export default function pixBashExtension(pi: PiPrettyApi): void {
	once(pi, "pix-bash", () => {
		const createBashTool = (createBashToolDefinition ??
			createBashToolFallback) as unknown as ToolFactory<BashToolInput>;
		if (!createBashTool) return;

		let TextComponent: TextComponentCtor;
		try {
			TextComponent = require("@earendil-works/pi-tui").Text;
		} catch {
			return;
		}

		const cwd = process.cwd();
		const home = process.env.HOME ?? "";

		registerBashTool(pi, createBashTool, {
			cwd,
			sp: (p: string) => shortPath(cwd, home, p),
			TextComponent: viewportTextConstructor(TextComponent),
			fffState,
			cursorStore: new CursorStore(),
		});
	});
}
