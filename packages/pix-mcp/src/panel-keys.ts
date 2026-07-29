import { Key, matchesKey } from "@earendil-works/pi-tui";

/** The `tui.select.*` keybinding ids the adapter panels resolve. */
export type PanelSelectKeybinding =
	| "tui.select.up"
	| "tui.select.down"
	| "tui.select.pageUp"
	| "tui.select.pageDown"
	| "tui.select.confirm";

/** Structural subset of pi-tui's `KeybindingsManager` (which satisfies it). */
export interface PanelKeybindings {
	matches(data: string, keybinding: PanelSelectKeybinding): boolean;
}

/**
 * Key matchers for list navigation: user's `tui.select.*` bindings when a
 * manager is provided, otherwise the previous hardcoded defaults.
 */
export interface PanelKeys {
	selectUp(data: string): boolean;
	selectDown(data: string): boolean;
	selectPageUp(data: string): boolean;
	selectPageDown(data: string): boolean;
	selectConfirm(data: string): boolean;
}

export function createPanelKeys(keybindings?: PanelKeybindings): PanelKeys {
	if (keybindings) {
		return {
			selectUp: (data) => keybindings.matches(data, "tui.select.up"),
			selectDown: (data) => keybindings.matches(data, "tui.select.down"),
			selectPageUp: (data) => keybindings.matches(data, "tui.select.pageUp"),
			selectPageDown: (data) => keybindings.matches(data, "tui.select.pageDown"),
			selectConfirm: (data) => keybindings.matches(data, "tui.select.confirm"),
		};
	}
	return {
		selectUp: (data) => matchesKey(data, "up"),
		selectDown: (data) => matchesKey(data, Key.down),
		selectPageUp: (data) => matchesKey(data, Key.pageUp),
		selectPageDown: (data) => matchesKey(data, Key.pageDown),
		selectConfirm: (data) => matchesKey(data, Key.return),
	};
}
