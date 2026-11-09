import { afterEach, expect, jest, test } from "bun:test";
import { getKeybindings } from "@earendil-works/pi-tui";
import { confirmOverlay } from "./confirm.ts";
import { showOverlay } from "./gate-overlay.ts";
import { createOverlayLifecycle } from "./overlay-lifecycle.ts";
import { openProgress } from "./progress.ts";

const theme = {
	fg: (_role: string, text: string) => text,
	bg: (_role: string, text: string) => text,
	bold: (text: string) => text,
};
type Component = { render(width: number): string[]; handleInput(data: string): void };

function harness(options: { delayed?: boolean; throwOnOpen?: Error } = {}) {
	let component!: Component;
	let open!: () => void;
	let dismiss!: () => void;
	let fail!: (error: Error) => void;
	let finishes = 0;
	let renders = 0;
	const ui = {
		custom<T>(
			build: (
				tui: { requestRender(): void },
				th: typeof theme,
				kb: ReturnType<typeof getKeybindings>,
				done: (value: T) => void,
			) => Component,
		): Promise<T | undefined> {
			const pending = new Promise<T | undefined>((resolve, reject) => {
				dismiss = () => resolve(undefined);
				fail = reject;
				open = () => {
					component = build(
						{
							requestRender() {
								renders++;
							},
						},
						theme,
						getKeybindings(),
						(value) => {
							finishes++;
							resolve(value);
						},
					);
				};
			});
			if (!options.delayed) open();
			if (options.throwOnOpen) throw options.throwOnOpen;
			return pending;
		},
	};
	return {
		ui,
		get component() {
			return component;
		},
		get finishes() {
			return finishes;
		},
		get renders() {
			return renders;
		},
		open: () => open(),
		dismiss: () => dismiss(),
		fail: (error: Error) => fail(error),
	};
}

afterEach(() => jest.useRealTimers());

test("lifecycle settles once, including before the UI factory runs", () => {
	const lifecycle = createOverlayLifecycle<string>();
	const events: string[] = [];
	lifecycle.onCleanup(() => events.push("cleanup"));
	lifecycle.finish("first");
	lifecycle.finish("late");
	lifecycle.bind((value) => events.push(value));
	lifecycle.dispose();
	lifecycle.onCleanup(() => events.push("late cleanup"));
	expect(lifecycle.closed).toBe(true);
	expect(events).toEqual(["cleanup", "first", "late cleanup"]);
});

test("host dismissal cancels validation and ignores a late approval", async () => {
	const h = harness();
	let complete!: (value: boolean) => void;
	let signal: AbortSignal | undefined;
	const pending = showOverlay(h.ui, {
		mode: "sudo",
		title: "Password",
		validatePassword: (_password, validationSignal) => {
			signal = validationSignal;
			return new Promise<boolean>((resolve) => {
				complete = resolve;
			});
		},
	});
	h.component.handleInput("\r");
	h.component.handleInput("password");
	h.component.handleInput("\r");
	h.dismiss();
	expect(await pending).toEqual({ action: "denied" });
	expect(signal?.aborted).toBe(true);
	const renders = h.renders;
	complete(true);
	await Promise.resolve();
	expect(h.finishes).toBe(0);
	expect(h.renders).toBe(renders);
});

test.each([
	"gate",
	"confirm",
] as const)("%s ignores repeated input and clears its timer", async (kind) => {
	jest.useFakeTimers();
	const h = harness();
	const result =
		kind === "gate"
			? showOverlay(h.ui, { mode: "confirm", title: "Gate", timeoutMs: 1000 })
			: confirmOverlay(h.ui, { title: "Confirm", timeoutMs: 1000 });
	h.component.handleInput("\r");
	h.component.handleInput("\x1b");
	await result;
	const renders = h.renders;
	jest.advanceTimersByTime(5000);
	h.component.handleInput("\r");
	expect(h.finishes).toBe(1);
	expect(h.renders).toBe(renders);
});

test.each([
	"gate",
	"confirm",
	"progress",
] as const)("%s cleans up after host dismissal or failure", async (kind) => {
	jest.useFakeTimers();
	for (const failure of [false, true]) {
		const h = harness();
		const error = new Error("host UI failed");
		const progress = kind === "progress" ? openProgress(h.ui, "Progress") : undefined;
		const result =
			kind === "gate"
				? showOverlay(h.ui, { mode: "confirm", title: "Gate", timeoutMs: 1000 })
				: kind === "confirm"
					? confirmOverlay(h.ui, { title: "Confirm", timeoutMs: 1000 })
					: undefined;
		if (failure) h.fail(error);
		else h.dismiss();
		if (progress) await Promise.resolve();
		if (failure) await expect(result ?? progress!.close()).rejects.toBe(error);
		else await (result ?? progress!.close());
		const renders = h.renders;
		jest.advanceTimersByTime(5000);
		h.component.handleInput("\r");
		progress?.setLabel("too late");
		expect(h.finishes).toBe(0);
		expect(h.renders).toBe(renders);
	}
});

test.each([
	"gate",
	"confirm",
	"progress",
] as const)("%s cleans resources if custom throws synchronously", async (kind) => {
	jest.useFakeTimers();
	const error = new Error("factory failed");
	const h = harness({ throwOnOpen: error });
	if (kind === "gate")
		await expect(
			showOverlay(h.ui, { mode: "confirm", title: "Gate", timeoutMs: 1000 }),
		).rejects.toBe(error);
	else if (kind === "confirm")
		await expect(confirmOverlay(h.ui, { title: "Confirm", timeoutMs: 1000 })).rejects.toBe(error);
	else expect(() => openProgress(h.ui, "Progress")).toThrow(error);
	const renders = h.renders;
	jest.advanceTimersByTime(5000);
	h.component.handleInput("\r");
	expect(h.finishes).toBe(0);
	expect(h.renders).toBe(renders);
});

test("confirm timeout is absolute, unlike gate's inactivity timeout", async () => {
	jest.useFakeTimers();
	const h = harness();
	const pending = confirmOverlay(h.ui, { title: "Confirm", timeoutMs: 1000 });
	h.component.handleInput("\x1b[B");
	jest.advanceTimersByTime(1000);
	expect(await pending).toBe(false);
	expect(h.finishes).toBe(1);
});

test("confirm timeout survives delayed UI construction without duplicate completion", async () => {
	jest.useFakeTimers();
	const h = harness({ delayed: true });
	const pending = confirmOverlay(h.ui, { title: "Confirm", timeoutMs: 1000 });
	jest.advanceTimersByTime(1000);
	h.open();
	expect(await pending).toBe(false);
	jest.advanceTimersByTime(5000);
	expect(h.finishes).toBe(1);
	expect(h.renders).toBe(0);
});

test("progress close before deferred construction still closes once and stops rendering", async () => {
	jest.useFakeTimers();
	const h = harness({ delayed: true });
	const progress = openProgress(h.ui, "Progress");
	const closed = progress.close();
	h.open();
	await closed;
	await progress.close();
	progress.setLabel("late");
	jest.advanceTimersByTime(1000);
	expect(h.finishes).toBe(1);
	expect(h.renders).toBe(0);
});

test("progress keeps input ownership until explicitly closed", async () => {
	jest.useFakeTimers();
	const h = harness();
	const progress = openProgress(h.ui, "Progress");
	h.component.handleInput("\x1b");
	jest.advanceTimersByTime(120);
	expect(h.finishes).toBe(0);
	expect(h.renders).toBeGreaterThan(0);
	await progress.close();
	const renders = h.renders;
	progress.setLabel("late");
	await progress.close();
	jest.advanceTimersByTime(1000);
	expect(h.finishes).toBe(1);
	expect(h.renders).toBe(renders);
});
