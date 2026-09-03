// Shared test harness for tool renderers. Test-only — every pix tool package
// rebuilt these same mocks (MockTextComponent, capture-pi, theme, render ctx)
// by hand; this collapses them to one import. Pure and Pi-host-agnostic.

import type { CursorStore, FffState } from "./fff.js";
import type { ToolContext } from "./tools/context.js";
import type { PiPrettyApi, RenderContextLike, TextComponentCtor, ThemeLike } from "./types.js";

/** In-memory TextComponent: stores text, splits on render. */
export class MockTextComponent {
	private text: string;
	constructor(text = "") {
		this.text = text;
	}
	setText(value: string): void {
		this.text = value;
	}
	getText(): string {
		return this.text;
	}
	render(_width?: number): string[] {
		return this.text.split("\n");
	}
	invalidate(): void {}
}

/** The tool object a registrar hands to `registerTool`, with the render hooks tests poke. */
export interface CapturedTool {
	name?: string;
	renderCall?: (...args: unknown[]) => MockTextComponent;
	renderResult?: (...args: unknown[]) => MockTextComponent;
	[key: string]: unknown;
}

/**
 * A PiPrettyApi that captures every registered tool. `tool` is the last one
 * registered (Object.assign'd so render hooks are directly callable); `names`
 * lists all registered tool names in order.
 */
export function capturePi(): { pi: PiPrettyApi; tool: CapturedTool; names: string[] } {
	const tool: CapturedTool = {};
	const names: string[] = [];
	const pi: PiPrettyApi = {
		registerTool(t: unknown) {
			const name = (t as { name?: string }).name;
			if (name) names.push(name);
			Object.assign(tool, t);
		},
		registerCommand() {},
		on() {},
	};
	return { pi, tool, names };
}

/** Build the ToolContext every registrar expects; override any field. */
export function makeToolContext(overrides: Partial<ToolContext> = {}): ToolContext {
	return {
		cwd: process.cwd(),
		sp: (p: string) => p,
		// SAFETY: MockTextComponent implements the setText/getText/render/invalidate surface
		// TextComponentCtor requires; the ctor arity differs but callers only use `new C(text)`.
		TextComponent: MockTextComponent as unknown as TextComponentCtor,
		fffState: { module: null, finder: null, partialIndex: false, dbDir: null } as FffState,
		// SAFETY: tool renderers only call store()/get() on the cursor store; this stub covers both.
		cursorStore: { store: () => "", get: () => undefined } as unknown as CursorStore,
		...overrides,
	};
}

/**
 * Theme mock. Default is passthrough (`fg`/`bold` return the raw value).
 * Pass `tag: true` to wrap `dim`/`muted` foregrounds as `<key>value</key>`,
 * which lets tests assert on visual-hierarchy roles.
 */
export function makeTheme({ tag = false }: { tag?: boolean } = {}): ThemeLike {
	return {
		fg: (key: string, value: string) =>
			tag && (key === "dim" || key === "muted") ? `<${key}>${value}</${key}>` : value,
		bold: (value: string) => value,
	};
}

/**
 * Build a RenderContextLike with sane defaults; override expanded/isError/state/etc.
 * `state` is intentionally loose (`Record<string, unknown>`) because renderers stash
 * booleans/numbers/timers there at runtime that the strict `state` type doesn't model.
 */
export function makeRenderCtx(
	overrides: Partial<Omit<RenderContextLike, "state">> & { state?: Record<string, unknown> } = {},
): RenderContextLike {
	// SAFETY: loose state bag matches runtime renderer usage; the strict RenderContextLike
	// state type only lists string keys, but renderers read/write timers and flags there.
	return {
		expanded: false,
		isError: false,
		invalidate: () => {},
		state: {},
		...overrides,
	} as unknown as RenderContextLike;
}
