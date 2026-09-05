/**
 * icon-catalog.ts — re-export shim.
 *
 * The semantic icon catalog now lives in `@xynogen/pix-runtime` (a lower layer)
 * so that pix-runtime's own UI — the `/pix` settings overlay — can resolve
 * icons without a circular dependency on pix-pretty. This file re-exports the
 * whole surface unchanged, so every existing `@xynogen/pix-pretty/icon-catalog`
 * import keeps working.
 */

export {
	getIconMode,
	ICON_KEYS,
	ICON_MODES,
	type IconKey,
	type IconMode,
	icon,
	iconFor,
	onIconModeChange,
	setIconMode,
} from "@xynogen/pix-runtime/icon-catalog";
