import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Text, type TUI } from "@earendil-works/pi-tui";

type Widget = Component & { dispose?(): void };
type Content = string[] | ((tui: TUI, theme: Theme) => Widget) | undefined;
type Options = { placement?: "aboveEditor" | "belowEditor" };

const ORDER = [
	"pix-transient-error",
	"welcome",
	"pi-lens-lsp",
	"pix-proc:procs",
	"pix-aria2:progress",
	"agents",
	"pix-btw-live",
	"voice-stt",
];
const GROUP = "pix-ordered-widgets";

/** Keep Pix widgets in one host slot; Pi moves individually updated slots to the end. */
export function installOrderedWidgets(ui: Pick<ExtensionUIContext, "setWidget">): () => void {
	const original = ui.setWidget as (key: string, content: Content, options?: Options) => void;
	const below = new Set<string>();
	const widgets = new Map<string, Widget>();
	let environment: { tui: TUI; theme: Theme } | undefined;

	const clear = () => {
		const children = [...widgets.values()];
		widgets.clear();
		environment = undefined;
		for (const child of children) child.dispose?.();
	};
	const setWidget = (key: string, content: Content, options?: Options) => {
		if (!ORDER.includes(key)) {
			original.call(ui, key, content, options);
			return;
		}
		const previous = widgets.get(key);
		widgets.delete(key);
		previous?.dispose?.();
		if (below.delete(key)) original.call(ui, key, undefined);

		if (content !== undefined && options?.placement !== "belowEditor") {
			if (!environment) {
				original.call(
					ui,
					GROUP,
					(tui: TUI, theme: Theme) => {
						environment = { tui, theme };
						return {
							render: (width: number) =>
								ORDER.flatMap((name) => widgets.get(name)?.render(width) ?? []),
							invalidate: () => {
								for (const widget of widgets.values()) widget.invalidate();
							},
							dispose: clear,
						};
					},
					{ placement: "aboveEditor" },
				);
			}
			if (environment) {
				let widget: Widget;
				if (Array.isArray(content)) {
					const container = new Container();
					for (const line of content.slice(0, 10)) container.addChild(new Text(line, 1, 0));
					if (content.length > 10) {
						container.addChild(
							new Text(environment.theme.fg("muted", "... (widget truncated)"), 1, 0),
						);
					}
					widget = container;
				} else {
					widget = content(environment.tui, environment.theme);
				}
				widgets.set(key, widget);
			}
		} else if (options?.placement === "belowEditor") {
			original.call(ui, key, content, options);
			if (content !== undefined) below.add(key);
		}
		if (widgets.size === 0 && environment) original.call(ui, GROUP, undefined);
		environment?.tui.requestRender();
	};
	ui.setWidget = setWidget;
	return () => {
		if (ui.setWidget === setWidget) ui.setWidget = original;
		if (environment) original.call(ui, GROUP, undefined);
	};
}
