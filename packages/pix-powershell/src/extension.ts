import {
	type BashToolInput,
	createLocalPowerShellOperations,
	createPowerShellToolDefinition,
	type ExtensionAPI,
	getPowerShellConfig,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { CursorStore, fffState } from "@xynogen/pix-pretty/fff";
import type { PiPrettyApi, ToolFactory } from "@xynogen/pix-pretty/types";
import { linkedShortPath, viewportTextConstructor } from "@xynogen/pix-pretty/utils";
import { once } from "@xynogen/pix-runtime/once";
import { homeDir } from "@xynogen/pix-runtime/paths";
import { currentPlatform } from "@xynogen/pix-runtime/platform";
import { createPixPowerShellOperations } from "./operations.ts";
import { registerPowerShellTool } from "./powershell.ts";

/** Pi's PowerShell tool with plain-text output and a 5.1 `&&`/`||` shim. */
function defaultCreateTool(): ToolFactory<BashToolInput> | undefined {
	if (!createPowerShellToolDefinition || !createLocalPowerShellOperations) return undefined;
	return ((cwd: string) =>
		createPowerShellToolDefinition(cwd, {
			operations: createPixPowerShellOperations(
				createLocalPowerShellOperations(),
				() => getPowerShellConfig?.().shell,
			),
		})) as unknown as ToolFactory<BashToolInput>;
}

export interface PixPowerShellOptions {
	/** Host platform; injectable for tests. Defaults to pix-runtime host detection. */
	platform?: NodeJS.Platform;
	/** Shell tool factory; injectable for tests. Defaults to Pi's PowerShell definition. */
	createTool?: ToolFactory<BashToolInput>;
}

/** Enable PowerShell automatically on Windows; leave it unregistered on other hosts. */
export function createPixPowerShellExtension(options: PixPowerShellOptions = {}) {
	return function pixPowerShellExtension(pi: ExtensionAPI): void {
		const platform = options.platform ?? currentPlatform().os;
		// Pi exposes the powershell tool only on native Windows.
		if (platform !== "win32") return;
		const createTool = options.createTool ?? defaultCreateTool();
		if (!createTool) return; // older Pi without a powershell tool

		once(pi, "pix-powershell", () => {
			const cwd = process.cwd();
			const home = homeDir();
			registerPowerShellTool(pi as unknown as PiPrettyApi, createTool, {
				cwd,
				sp: (p: string) => linkedShortPath(cwd, home, p),
				TextComponent: viewportTextConstructor(Text),
				fffState,
				cursorStore: new CursorStore(),
			});
		});
	};
}

export default createPixPowerShellExtension();
