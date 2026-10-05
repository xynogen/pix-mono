import { expect, spyOn, test } from "bun:test";
import { captureRows, roleTheme, withUiFixture } from "../../../../scripts/ui-capture.ts";
import * as session from "./session.ts";

// ponytail: intercept runBtw. These checks reach registered handlers without a child session or provider.
async function captureBtw(onStage = (_stage: string) => {}) {
	const fixture = await withUiFixture({ hostTheme: true });
	let now = 200_000_000;
	const clock = spyOn(Date, "now").mockImplementation(() => now);
	const timer = spyOn(globalThis, "setInterval").mockImplementation(
		(() => 1) as unknown as typeof setInterval,
	);
	const clear = spyOn(globalThis, "clearInterval").mockImplementation(() => {});
	const results: ReturnType<typeof Promise.withResolvers<session.BtwRunResult>>[] = [];
	const runs: session.BtwRunOptions[] = [];
	const completions: Promise<unknown>[] = [];
	const runner = spyOn(session, "runBtw").mockImplementation((options) => {
		runs.push(options);
		const result = Promise.withResolvers<session.BtwRunResult>();
		results.push(result);
		// Track the handler's real then/catch chain, not a guessed microtask count.
		const then = result.promise.then.bind(result.promise);
		spyOn(result.promise, "then").mockImplementation((...args) => {
			const completion = then(...args);
			const caught = completion.catch.bind(completion);
			spyOn(completion, "catch").mockImplementation((...args) => {
				const finished = caught(...args).finally(() => onStage("completion-handled"));
				completions.push(finished);
				return finished;
			});
			return completion;
		});
		return result.promise;
	});
	let shutdown = () => {};
	const errors: unknown[] = [];
	try {
		const { registerBtw } = await import("./index.ts");
		let handler!: (args: string, ctx: unknown) => Promise<void>;
		let published = Promise.withResolvers<void>();
		const cards: unknown[] = [];
		const registrations: string[] = [];
		const contextEvents: string[] = [];
		const model = {
			provider: "fixture",
			id: "selected-model",
			name: "Selected model",
		} as session.BtwSnapshot["model"];
		const active = ["read", "grep", "read"];
		registerBtw({
			registerEntryRenderer: (name: string) => registrations.push(name),
			registerCommand: (_name: string, command: { handler: typeof handler }) => {
				handler = command.handler;
			},
			getThinkingLevel: () => "high",
			getActiveTools: () => active,
			appendEntry: (name: string, details: unknown) => {
				expect(name).toBe("pix-btw-answer");
				cards.push(details);
				published.resolve();
			},
			on: (event: string, callback: typeof shutdown) => {
				contextEvents.push(event);
				if (event === "session_shutdown") shutdown = callback;
			},
		} as never);
		let widget: { render(width: number): string[] } | undefined;
		let reads = 0;
		const ctx = {
			cwd: "/fixture-project",
			model,
			sessionManager: {
				buildContextEntries: () => {
					reads++;
					return Array.from({ length: 15 }, (_, i) => ({
						type: "message",
						message: { role: "user", content: `message-${i}` },
					}));
				},
			},
			ui: {
				notify() {},
				setStatus() {},
				setWidget: (
					_key: string,
					factory: ((tui: unknown, theme: unknown) => typeof widget) | undefined,
				) => {
					widget = factory?.({ terminal: { columns: 80 } }, roleTheme());
				},
			},
		};
		const output: string[] = [];
		await handler("What did we change?", ctx);
		onStage("runner-pending");
		expect(runs[0]?.snapshot).toEqual({
			cwd: ctx.cwd,
			model,
			thinkingLevel: "high",
			activeToolNames: active,
		});
		expect(runs[0]?.snapshot.model).toBe(model);
		expect(runs[0]?.snapshot.activeToolNames).not.toBe(active);
		expect(runs[0]?.contextPreamble).toBe(
			session.buildContextPreamble(ctx.sessionManager.buildContextEntries()),
		);
		expect(runs[0]?.contextPreamble?.match(/User: message-/g)).toHaveLength(10);
		if (!widget) throw new Error("BTW widget is missing");
		output.push("registered:running", ...captureRows(widget, { width: 80, surface: "component" }));
		now += 2_100;
		results[0]?.resolve({
			text: "Read the file.",
			thinking: "Reasoning",
			session: undefined as never,
		});
		await published.promise;
		output.push(
			"registered:completed",
			...captureRows(widget, { width: 80, surface: "component" }),
		);
		expect(cards[0]).toMatchObject({
			question: "What did we change?",
			model: "Selected model",
			thinkingLevel: "high",
			durationMs: 2_100,
			answer: "Read the file.",
			thinking: "Reasoning",
		});
		published = Promise.withResolvers<void>();
		const before = reads;
		await handler("--no-ctx Where is the file?", ctx);
		expect(reads).toBe(before);
		expect(runs[1]).toMatchObject({ question: "Where is the file?", contextPreamble: undefined });
		results[1]?.resolve({ text: "auth.ts", thinking: "", session: undefined as never });
		await published.promise;
		expect(registrations).toEqual(["pix-btw-answer"]);
		expect(contextEvents).toEqual(["session_start", "session_shutdown"]);
		shutdown();
		expect(widget).toBeUndefined();
		expect(clear).toHaveBeenCalledTimes(1);
		onStage("capture-completed");
		expect(output.join("\n")).toMatchSnapshot();
	} catch (error) {
		errors.push(error);
	} finally {
		try {
			try {
				shutdown();
			} finally {
				for (const result of results)
					result.resolve({ text: "", thinking: "", session: undefined as never });
				const settled = await Promise.allSettled(completions);
				for (const result of settled) if (result.status === "rejected") errors.push(result.reason);
			}
			onStage("work-settled");
		} catch (error) {
			errors.push(error);
		} finally {
			try {
				for (const restore of [
					() => onStage("dependencies-restoring"),
					() => runner.mockRestore(),
					() => clear.mockRestore(),
					() => timer.mockRestore(),
					() => clock.mockRestore(),
				]) {
					try {
						restore();
					} catch (error) {
						errors.push(error);
					}
				}
			} finally {
				try {
					await fixture.restore();
					onStage("fixture-restored");
				} catch (error) {
					errors.push(error);
				}
			}
		}
	}
	if (errors.length) throw errors[0];
}

test("BTW handler keeps bounded default context, opt-out, model inheritance, and display isolation", async () => {
	await captureBtw();
});

test("BTW assertion failures await fake completion handlers before restoring dependencies", async () => {
	for (const stage of ["runner-pending", "capture-completed"]) {
		const clock = Date.now;
		const runner = session.runBtw;
		const timer = setInterval;
		const clear = clearInterval;
		const runtime = Reflect.get(globalThis, Symbol.for("@xynogen/pix-runtime"));
		const original = new Error(`Fixture assertion failed at ${stage}`);
		const stages: string[] = [];
		await expect(
			captureBtw((current) => {
				stages.push(current);
				if (current === stage) throw original;
				if (stage === "runner-pending" && current === "completion-handled")
					throw new Error("Fixture completion failed");
				if (current === "dependencies-restoring") throw new Error("Fixture restore failed");
			}),
		).rejects.toBe(original);
		expect(stages.slice(-3)).toEqual([
			"work-settled",
			"dependencies-restoring",
			"fixture-restored",
		]);
		expect(stages.indexOf("completion-handled")).toBeLessThan(stages.indexOf("work-settled"));
		expect([Date.now, session.runBtw, setInterval, clearInterval]).toEqual([
			clock,
			runner,
			timer,
			clear,
		]);
		expect(Reflect.get(globalThis, Symbol.for("@xynogen/pix-runtime"))).toBe(runtime);
	}
});
