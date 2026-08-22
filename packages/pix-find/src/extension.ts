import {
	createFindToolDefinition,
	createFindTool as createFindToolFallback,
	type ExtensionAPI,
	type FindToolInput,
} from "@earendil-works/pi-coding-agent";
import { CursorStore, fffState } from "@xynogen/pix-pretty/fff";
import type { PiPrettyApi, TextComponentCtor, ToolFactory } from "@xynogen/pix-pretty/types";
import { shortPath, viewportTextConstructor } from "@xynogen/pix-pretty/utils";
import { once } from "@xynogen/pix-runtime/once";
import { registerFindTool } from "./find.js";

export default function pixFindExtension(pi: ExtensionAPI): void {
	const prettyPi = pi as unknown as PiPrettyApi;
	once(pi, "pix-find", () => {
		const createFindTool = (createFindToolDefinition ??
			createFindToolFallback) as unknown as ToolFactory<FindToolInput>;
		if (!createFindTool) return;

		let TextComponent: TextComponentCtor;
		try {
			TextComponent = require("@earendil-works/pi-tui").Text;
		} catch {
			return;
		}

		const cwd = process.cwd();
		const home = process.env.HOME ?? "";

		registerFindTool(prettyPi, createFindTool, {
			cwd,
			sp: (p: string) => shortPath(cwd, home, p),
			TextComponent: viewportTextConstructor(TextComponent),
			fffState,
			cursorStore: new CursorStore(),
		});
	});
}
