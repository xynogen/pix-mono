import { describe, expect, jest, test } from "bun:test";
import { type OverlayUI, showOverlay } from "./gate-overlay.ts";

// ── Mock host ─────────────────────────────────────────────────────────────────
//
// Drive showOverlay deterministically without a real TUI. The mock invokes the
// builder callback (so components initialise + wire their handlers), captures
// the rendered lines, then hands a `drive(comp, done)` hook to the test which
// triggers selectList.onSelect / maskedInput.onSubmit / etc via the real
// component instances — exactly what real keyboard input would do.

const theme = {
	fg: (_c: string, t: string) => t,
	bg: (_c: string, t: string) => t,
	bold: (t: string) => t,
};

interface Wired {
	render(w: number): string[];
	invalidate(): void;
	handleInput(d: string): void;
}

/**
 * Build a mock UI. `drive` receives the rendered lines and a `feed` fn that
 * pushes raw input strings into the component. To trigger a selection we feed
 * the SelectList keys; simpler: we expose the live component so the test can
 * call its handlers. We do the latter via the captured component ref.
 */
function makeUI(
	onReady: (comp: Wired, finish: (v: unknown) => void) => void,
	onOptions?: (options: unknown) => void,
): OverlayUI {
	return {
		custom: async <T>(
			cb: (
				tui: { requestRender(): void },
				th: typeof theme,
				kb: unknown,
				done: (v: T) => void,
			) => Wired,
			options?: unknown,
		): Promise<T | undefined> => {
			onOptions?.(options);
			let resolved: T | undefined;
			const done = (v: T) => {
				resolved = v;
			};
			const comp = cb({ requestRender: () => {} }, theme, undefined, done);
			comp.render(80); // initialise render path
			onReady(comp, done as (v: unknown) => void);
			return resolved;
		},
	};
}

// SelectList handles "\r" (enter) to select the highlighted item, and arrow
// keys to move. The first item is highlighted by default.
const ENTER = "\r";
const DOWN = "\x1b[B";

describe("showOverlay — confirm mode", () => {
	test("caps overlay at 80% of terminal height", async () => {
		let options: unknown;
		await showOverlay(
			makeUI(
				(comp) => comp.handleInput(ENTER),
				(value) => {
					options = value;
				},
			),
			{ mode: "confirm", title: "T" },
		);
		expect(options).toEqual({ overlay: true, overlayOptions: { maxHeight: "80%" } });
	});

	test("selecting the approve choice (first) returns approved", async () => {
		const result = await showOverlay(
			makeUI((comp) => {
				comp.handleInput(ENTER); // select item 0 = "yes"
			}),
			{ mode: "confirm", title: "T", timeoutMs: 0 },
		);
		expect(result.action).toBe("approved");
		expect(result.password).toBeUndefined();
	});

	test("selecting the deny choice (second) returns denied", async () => {
		const result = await showOverlay(
			makeUI((comp) => {
				comp.handleInput(DOWN); // move to item 1 = "no"
				comp.handleInput(ENTER);
			}),
			{ mode: "confirm", title: "T", timeoutMs: 0 },
		);
		expect(result.action).toBe("denied");
	});

	test("deny-first ordering: item 0 is the deny choice when configured so", async () => {
		const result = await showOverlay(
			makeUI((comp) => {
				comp.handleInput(ENTER); // select item 0
			}),
			{
				mode: "confirm",
				title: "Critical",
				timeoutMs: 0,
				approveValue: "yes",
				choices: [
					{ value: "no", label: "Block", description: "deny" },
					{ value: "yes", label: "Allow", description: "approve" },
				],
			},
		);
		// item 0 = "no" => not the approveValue => denied
		expect(result.action).toBe("denied");
	});

	test("renders title and body lines", async () => {
		let captured: string[] = [];
		await showOverlay(
			makeUI((comp) => {
				captured = comp.render(80);
				comp.handleInput(ENTER);
			}),
			{
				mode: "confirm",
				title: "MY TITLE",
				body: ["body-line-x"],
				timeoutMs: 0,
			},
		);
		const joined = captured.join("\n");
		expect(joined).toContain("MY TITLE");
		expect(joined).toContain("body-line-x");
	});

	test("wraps a long body command instead of truncating it", async () => {
		// A command far wider than any modal width — must survive in full, wrapped.
		const longCmd = `echo ${"pix-gate-installed-or-linked ".repeat(8)}done`;
		let captured: string[] = [];
		await showOverlay(
			makeUI((comp) => {
				captured = comp.render(80);
				comp.handleInput(ENTER);
			}),
			{ mode: "confirm", title: "T", body: [longCmd], timeoutMs: 0 },
		);
		// Every whitespace-delimited token of the command appears somewhere in the
		// frame — nothing was dropped by truncation.
		const joined = captured.join("\n");
		for (const tok of longCmd.split(" ")) expect(joined).toContain(tok);
	});
});

describe("showOverlay — sudo mode", () => {
	test("approve then submit password returns approved + real password", async () => {
		const result = await showOverlay(
			makeUI((comp) => {
				comp.handleInput(ENTER); // select item 0 = "yes" => switch to password stage
				comp.handleInput("s3cret"); // type into MaskedInput
				comp.handleInput(ENTER); // submit
			}),
			{ mode: "sudo", title: "ROOT", timeoutMs: 0 },
		);
		expect(result.action).toBe("approved");
		expect(result.password).toBe("s3cret");
	});

	test("deny at select stage returns denied, never reaches password", async () => {
		const result = await showOverlay(
			makeUI((comp) => {
				comp.handleInput(DOWN); // item 1 = "no"
				comp.handleInput(ENTER);
			}),
			{ mode: "sudo", title: "ROOT", timeoutMs: 0 },
		);
		expect(result.action).toBe("denied");
		expect(result.password).toBeUndefined();
	});

	test("wrong password retries inside the same overlay", async () => {
		let component: Wired | undefined;
		let overlayCount = 0;
		const attempts: string[] = [];
		const ui: OverlayUI = {
			custom: <T>(cb: Parameters<OverlayUI["custom"]>[0]): Promise<T | undefined> => {
				overlayCount += 1;
				return new Promise((resolve) => {
					component = cb({ requestRender: () => {} }, theme, undefined, (value) =>
						resolve(value as T),
					);
				});
			},
		};

		const pending = showOverlay(ui, {
			mode: "sudo",
			title: "ROOT",
			timeoutMs: 0,
			maxPasswordAttempts: 3,
			validatePassword: async (password) => {
				attempts.push(password);
				return password === "correct";
			},
		});
		component?.handleInput(ENTER);
		component?.handleInput("wrong");
		component?.handleInput(ENTER);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(component?.render(80).join("\n")).toContain("Incorrect password — attempt 1 of 3");
		component?.handleInput("correct");
		component?.handleInput(ENTER);

		expect(await pending).toEqual({ action: "approved", password: "correct" });
		expect(attempts).toEqual(["wrong", "correct"]);
		expect(overlayCount).toBe(1);
	});

	test("password is masked in render (● not plaintext)", async () => {
		let pwFrame: string[] = [];
		await showOverlay(
			makeUI((comp) => {
				comp.handleInput(ENTER); // to password stage
				comp.handleInput("abc");
				pwFrame = comp.render(80);
				comp.handleInput(ENTER); // submit so the promise resolves
			}),
			{ mode: "sudo", title: "ROOT", timeoutMs: 0 },
		);
		const joined = pwFrame.join("\n");
		expect(joined).not.toContain("abc");
		expect(joined).toContain("●");
	});
});

// ── Auto-deny timer (dead-man's switch) ───────────────────────────────────────
//
// Timer-aware mock: unlike makeUI, this keeps the promise pending and resolves
// only when `done` fires — so a real setInterval expiry can drive the result.
// `onReady` gets the live component to optionally feed input before expiry.
function makeTimerUI(onReady?: (comp: Wired) => void): OverlayUI {
	return {
		custom: <T>(
			cb: (
				tui: { requestRender(): void },
				th: typeof theme,
				kb: unknown,
				done: (v: T) => void,
			) => Wired,
		): Promise<T | undefined> =>
			new Promise((resolve) => {
				const comp = cb({ requestRender: () => {} }, theme, undefined, (v) => resolve(v));
				comp.render(80);
				onReady?.(comp);
			}),
	};
}

describe("showOverlay — auto-deny timer", () => {
	test("expires to timeout when left untouched", async () => {
		jest.useFakeTimers();
		try {
			const pending = showOverlay(makeTimerUI(), {
				mode: "confirm",
				title: "T",
				timeoutMs: 1000, // ceil → 1s, fires on first tick
			});
			jest.advanceTimersByTime(1000); // fire the auto-deny tick without a real wait
			const result = await pending;
			expect(result.action).toBe("timeout");
		} finally {
			jest.useRealTimers();
		}
	});

	test("first keypress cancels the timer (no auto-deny)", async () => {
		jest.useFakeTimers();
		try {
			let live: Wired | undefined;
			const pending = showOverlay(
				makeTimerUI((comp) => {
					live = comp;
					comp.handleInput(DOWN); // any key — cancels the dead-man's switch
				}),
				{ mode: "confirm", title: "T", timeoutMs: 1000 },
			);
			// Advance well past the 1s window. A live timer would have resolved
			// "timeout"; the keypress cancelled it, so the promise stays pending.
			jest.advanceTimersByTime(1300);
			live?.handleInput(ENTER); // now deny explicitly
			const result = await pending;
			expect(result.action).toBe("denied");
		} finally {
			jest.useRealTimers();
		}
	});
});
