import { TuiMainScreen } from "@earendil-works/pi-tui";

const PATCHED = Symbol.for("@xynogen/pix-pretty:overlay-images");
type Compositor = {
	hasOverlay(): boolean;
	compositeOverlays(lines: string[], width: number, height: number): string[];
	[PATCHED]?: boolean;
};

/** Let the native renderer remove image placements before it draws an overlay. */
export function installOverlayImages(): void {
	const prototype = Object.getPrototypeOf(TuiMainScreen.prototype) as Compositor;
	if (prototype[PATCHED]) return;
	const compose = prototype.compositeOverlays;
	// ponytail: Pi skips overlay composition on image lines; suppress transcript images until upstream supports image occlusion.
	prototype.compositeOverlays = function (lines, width, height) {
		const background = this.hasOverlay()
			? lines.map((line) =>
					line.includes("\x1b_G") || line.includes("\x1b]1337;File=") ? "" : line,
				)
			: lines;
		return compose.call(this, background, width, height);
	};
	prototype[PATCHED] = true;
}
