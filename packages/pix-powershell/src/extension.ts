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
	/** Host platform; injectable for tests. Defaults to `process.platform`. */
	platform?: NodeJS.Platform;
	/** Shell tool factory; injectable for tests. Defaults to Pi's PowerShell definition. */
	createTool?: ToolFactory<BashToolInput>;
}

/**
 * Pretty renderer for Pi's optional built-in `powershell` tool.
 *
 * Pi activates every extension-registered tool at startup, so registering at
 * load time would silently enable `powershell` (and its schema tokens) for
 * every session. Instead, override the tool only once the user has enabled it
 * (`defaultTools`, `--tools`, pix-toolbox). Re-registering an existing tool
 * name keeps Pi's active set unchanged.
 *
 * Checked at `session_start` AND `before_agent_start`: other extensions (e.g.
 * pix-toolbox restoring toolbox.json) may activate `powershell` in their own
 * later `session_start` handler, or mid-session. `before_agent_start` runs
 * before every prompt, so the renderer is in place before the model can call it.
 */
export function createPixPowerShellExtension(options: PixPowerShellOptions = {}) {
	return function pixPowerShellExtension(pi: ExtensionAPI): void {
		const platform = options.platform ?? process.platform;
		// Pi exposes the powershell tool only on native Windows.
		if (platform !== "win32") return;
		const createTool = options.createTool ?? defaultCreateTool();
		if (!createTool) return; // older Pi without a powershell tool

		once(pi, "pix-powershell", () => {
			let registered = false;
			const maybeRegister = (): void => {
				if (registered || !pi.getActiveTools().includes("powershell")) return;

				registered = true;
				const cwd = process.cwd();
				const home = homeDir();
				registerPowerShellTool(pi as unknown as PiPrettyApi, createTool, {
					cwd,
					sp: (p: string) => linkedShortPath(cwd, home, p),
					TextComponent: viewportTextConstructor(Text),
					fffState,
					cursorStore: new CursorStore(),
				});
			};
			pi.on("session_start", maybeRegister);
			pi.on("before_agent_start", maybeRegister);
		});
	};
}

export default createPixPowerShellExtension();
