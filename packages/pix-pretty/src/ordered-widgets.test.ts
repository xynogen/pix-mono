import { expect, mock, test } from "bun:test";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { installOrderedWidgets } from "./ordered-widgets.ts";

type Widget = Component & { dispose?(): void };
type Content = string[] | ((tui: TUI, theme: Theme) => Widget) | undefined;

function host() {
	const widgets = new Map<string, Widget>();
	const calls: string[] = [];
	const tui = { requestRender: mock() } as unknown as TUI;
	const ui = {
		setWidget(key: string, content: Content) {
			calls.push(key);
			widgets.get(key)?.dispose?.();
			widgets.delete(key);
			if (content !== undefined) {
				widgets.set(
					key,
					typeof content === "function"
						? content(tui, { fg: (_role: string, text: string) => text } as Theme)
						: { render: () => content, invalidate() {} },
				);
			}
		},
	} as Pick<ExtensionUIContext, "setWidget">;
	const original = ui.setWidget;
	const restore = installOrderedWidgets(ui);
	return {
		ui,
		original,
		restore,
		widgets,
		calls,
		tui,
		lines: () => [...widgets.values()].flatMap((widget) => widget.render(80)),
	};
}

const row =
	(text: string, dispose = mock()) =>
	() => ({
		render: () => [text],
		invalidate: mock(),
		dispose,
	});

test("info, LSP, and processes retain their order across updates, expiry, and reappearance", () => {
	const h = host();
	h.ui.setWidget("pix-proc:procs", row("process"));
	h.ui.setWidget("pi-lens-lsp", row("LSP"));
	h.ui.setWidget("pix-transient-error", row("info"));
	expect(h.lines()).toEqual(["info", "LSP", "process"]);
	const dispose = mock();
	h.ui.setWidget("pix-proc:procs", row("process 2", dispose));
	h.ui.setWidget("pi-lens-lsp", row("LSP 2"));
	h.ui.setWidget("pix-proc:procs", row("process 3"));
	expect(dispose).toHaveBeenCalledTimes(1);
	expect(h.lines()).toEqual(["info", "LSP 2", "process 3"]);
	h.ui.setWidget("pix-transient-error", undefined);
	expect(h.lines()).toEqual(["LSP 2", "process 3"]);
	h.ui.setWidget("pix-transient-error", row("warning"));
	expect(h.lines()).toEqual(["warning", "LSP 2", "process 3"]);
	expect(h.calls).toEqual(["pix-ordered-widgets"]);
	expect(h.tui.requestRender).toHaveBeenCalled();
	h.restore();
});

test("other extensions and below-editor widgets stay outside the Pix container", () => {
	const h = host();
	h.ui.setWidget("other-extension", row("other"));
	h.ui.setWidget("pix-proc:procs", row("below"), { placement: "belowEditor" });
	expect([...h.widgets.keys()]).toEqual(["other-extension", "pix-proc:procs"]);
	h.ui.setWidget("pix-proc:procs", row("above"));
	expect([...h.widgets.keys()]).toEqual(["other-extension", "pix-ordered-widgets"]);
	expect(h.lines()).toEqual(["other", "above"]);
	h.ui.setWidget("pix-proc:procs", row("below again"), { placement: "belowEditor" });
	expect([...h.widgets.keys()]).toEqual(["other-extension", "pix-proc:procs"]);
	h.restore();
	expect(h.ui.setWidget).toBe(h.original);
});

test("clear and shutdown dispose children once and allow a fresh host slot", () => {
	const h = host();
	const dispose = mock();
	h.ui.setWidget("pix-proc:procs", row("process", dispose));
	const invalidate = mock();
	h.ui.setWidget("pi-lens-lsp", () => ({ render: () => ["LSP"], invalidate }));
	h.widgets.get("pix-ordered-widgets")?.invalidate();
	expect(invalidate).toHaveBeenCalledTimes(1);
	h.ui.setWidget("pix-proc:procs", undefined);
	h.ui.setWidget("pi-lens-lsp", undefined);
	expect(h.widgets.size).toBe(0);
	expect(dispose).toHaveBeenCalledTimes(1);
	h.ui.setWidget("pix-proc:procs", row("new", dispose));
	expect(h.lines()).toEqual(["new"]);
	h.restore();
	h.restore();
	expect(h.ui.setWidget).toBe(h.original);
	expect(h.widgets.size).toBe(0);
	expect(dispose).toHaveBeenCalledTimes(2);
});

test("string widgets retain the host line limit and narrow-width rendering", () => {
	const h = host();
	h.ui.setWidget(
		"pi-lens-lsp",
		Array.from({ length: 15 }, (_, i) => `line ${i}`),
	);
	expect(h.lines()).toHaveLength(11);
	expect(h.lines()[10]?.trim()).toBe("... (widget truncated)");
	for (const line of h.widgets.get("pix-ordered-widgets")?.render(12) ?? []) {
		expect(Bun.stringWidth(line)).toBeLessThanOrEqual(12);
	}
	h.restore();
});
