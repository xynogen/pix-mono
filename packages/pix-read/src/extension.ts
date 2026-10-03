import {
	createReadToolDefinition,
	createReadTool as createReadToolFallback,
	type ExtensionAPI,
	type ReadToolInput,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { CursorStore, fffState } from "@xynogen/pix-pretty/fff";
import type { PiPrettyApi, ToolFactory } from "@xynogen/pix-pretty/types";
import { shortPath, viewportTextConstructor } from "@xynogen/pix-pretty/utils";

import { initHashline } from "@xynogen/pix-runtime/hashline";
import { once } from "@xynogen/pix-runtime/once";
import { homeDir } from "@xynogen/pix-runtime/paths";
import { registerReadTool } from "./read.ts";

export default async function pixReadExtension(pi: ExtensionAPI): Promise<void> {
	await initHashline();
	const prettyPi = pi as unknown as PiPrettyApi;
	once(pi, "pix-read", () => {
		const createReadTool = (createReadToolDefinition ??
			createReadToolFallback) as unknown as ToolFactory<ReadToolInput>;
		if (!createReadTool) return;

		const cwd = process.cwd();
		const home = homeDir();

		registerReadTool(prettyPi, createReadTool, {
			cwd,
			sp: (p: string) => shortPath(cwd, home, p),
			TextComponent: viewportTextConstructor(Text),
			fffState,
			cursorStore: new CursorStore(),
		});
	});
}
