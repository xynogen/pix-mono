import {
	createReadToolDefinition,
	createReadTool as createReadToolFallback,
	type ExtensionAPI,
	type ReadToolInput,
} from "@earendil-works/pi-coding-agent";
import { CursorStore, fffState } from "@xynogen/pix-pretty/fff";
import type { PiPrettyApi, TextComponentCtor, ToolFactory } from "@xynogen/pix-pretty/types";
import { shortPath, viewportTextConstructor } from "@xynogen/pix-pretty/utils";

import { once } from "@xynogen/pix-runtime/once";
import { registerReadTool } from "./read.js";

export default function pixReadExtension(pi: ExtensionAPI): void {
	const prettyPi = pi as unknown as PiPrettyApi;
	once(pi, "pix-read", () => {
		const createReadTool = (createReadToolDefinition ??
			createReadToolFallback) as unknown as ToolFactory<ReadToolInput>;
		if (!createReadTool) return;

		let TextComponent: TextComponentCtor;
		try {
			TextComponent = require("@earendil-works/pi-tui").Text;
		} catch {
			return;
		}

		const cwd = process.cwd();
		const home = process.env.HOME ?? "";

		registerReadTool(prettyPi, createReadTool, {
			cwd,
			sp: (p: string) => shortPath(cwd, home, p),
			TextComponent: viewportTextConstructor(TextComponent),
			fffState,
			cursorStore: new CursorStore(),
		});
	});
}
