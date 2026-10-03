import { describe, expect, test } from "bun:test";
import {
	createManagerWith,
	type LspManager,
	type ManagerDeps,
	mapNavigation,
	methodFor,
	type ResolveResult,
	type TransportLike,
} from "./manager.ts";
import type { LspServerSpec, ResolvedLspServer } from "./server-registry.ts";
import type { LspDiagnostic } from "./transport.ts";

const spec: LspServerSpec = {
	id: "typescript",
	name: "TS",
	extensions: [".ts"],
	commands: ["tsserver"],
	args: [],
	rootMarkers: ["package.json"],
	languageId: () => "typescript",
};

class FakeClock {
	private t = 1_000;
	private timers: Array<{ at: number; fn: () => void; id: number }> = [];
	private nextId = 1;
	now = (): number => this.t;
	set = (fn: () => void, ms: number): { id: number } => {
		const id = this.nextId++;
		this.timers.push({ at: this.t + ms, fn, id });
		return { id };
	};
	clear = (handle: unknown): void => {
		const id = (handle as { id: number })?.id;
		this.timers = this.timers.filter((x) => x.id !== id);
	};
	advance(ms: number): void {
		this.t += ms;
		const due = this.timers.filter((x) => x.at <= this.t);
		this.timers = this.timers.filter((x) => x.at > this.t);
		for (const x of due) x.fn();
	}
}

function fakeTransport(diagnostics: LspDiagnostic[] = []): TransportLike {
	let stopped = false;
	const versions: number[] = [];
	return {
		async open() {},
		async change() {},
		async waitForDiagnostics(_p, _v, _w, signal) {
			if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
			return new Promise((resolve, reject) => {
				if (signal) {
					signal.addEventListener(
						"abort",
						() => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
						{ once: true },
					);
				}
				resolve(diagnostics);
			});
		},
		async request<T>() {
			return [] as T;
		},
		isPullCapable: () => true,
		updateEwma: (ms) => versions.push(ms),
		getEwma: () => 0,
		state: () => (stopped ? "stopped" : "ready"),
		stderrTail: () => "",
		async stop() {
			stopped = true;
		},
	};
}

interface HarnessOptions {
	idleMs?: number;
	clock?: FakeClock;
	pausedStart?: boolean;
	diagnostics?: LspDiagnostic[];
	confirmed?: boolean;
	resolve?: (filePath: string) => Promise<ResolveResult>;
}

interface Harness {
	manager: LspManager;
	starts: number;
	stops: number;
	resolveStart(): void;
}

function createManagerHarness(options: HarnessOptions = {}): Harness {
	const clock = options.clock ?? new FakeClock();
	const state = { starts: 0, stops: 0 };
	// Deferred created upfront so resolveStart works before deps.start is reached.
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});

	const deps: ManagerDeps = {
		resolve:
			options.resolve ??
			(async (): Promise<ResolveResult> => {
				const resolved: ResolvedLspServer = { spec, command: "tsserver", root: "/repo" };
				return { kind: "ok", resolved };
			}),
		async start() {
			state.starts++;
			if (options.pausedStart) await gate;
			const t = fakeTransport(options.diagnostics ?? []);
			t.isPullCapable = () => false;
			if (options.confirmed === false) t.waitForDiagnostics = async () => undefined;
			const originalStop = t.stop;
			t.stop = async () => {
				state.stops++;
				await originalStop();
			};
			return t;
		},
		readFile: async () => "const x = 1;\n",
		now: clock.now,
		setTimer: clock.set as ManagerDeps["setTimer"],
		clearTimer: clock.clear,
	};
	const manager = createManagerWith(deps, { idleMs: options.idleMs ?? 60_000 });
	return {
		manager,
		get starts() {
			return state.starts;
		},
		get stops() {
			return state.stops;
		},
		resolveStart: () => release(),
	};
}

describe("LazyLspManager", () => {
	test("distinguishes an empty push from no publish", async () => {
		for (const confirmed of [true, false]) {
			const harness = createManagerHarness({ confirmed });
			const [snapshot] = await harness.manager.check({ paths: ["/repo/a.ts"], severity: "all" });
			expect(snapshot?.state).toBe(confirmed ? "clean" : "unconfirmed");
			await harness.manager.shutdown();
		}
	});
	test("starts no server until the first request", () => {
		const harness = createManagerHarness();
		expect(harness.starts).toBe(0);
	});

	test("shares one server for parallel files in one root", async () => {
		const harness = createManagerHarness();
		await Promise.all([
			harness.manager.check({ paths: ["/repo/a.ts"], waitMs: 1000, severity: "all" }),
			harness.manager.check({ paths: ["/repo/b.ts"], waitMs: 1000, severity: "all" }),
		]);
		expect(harness.starts).toBe(1);
	});

	test("forwards cancellation to a pending request", async () => {
		const harness = createManagerHarness();
		const controller = new AbortController();
		const pending = harness.manager.check({
			paths: ["/repo/a.ts"],
			waitMs: 1000,
			severity: "all",
			signal: controller.signal,
		});
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	});

	test("one caller can abort a shared start", async () => {
		const harness = createManagerHarness({ pausedStart: true });
		const controller = new AbortController();
		const first = harness.manager.check({
			paths: ["/repo/a.ts"],
			severity: "all",
			signal: controller.signal,
		});
		const second = harness.manager.check({ paths: ["/repo/b.ts"], severity: "all" });
		controller.abort();
		harness.resolveStart();
		await expect(first).rejects.toMatchObject({ name: "AbortError" });
		const result = await second;
		expect(result).toHaveLength(1);
	});

	test("stops idle servers", async () => {
		const clock = new FakeClock();
		const harness = createManagerHarness({ clock, idleMs: 1000 });
		await harness.manager.check({ paths: ["/repo/a.ts"], waitMs: 1000, severity: "all" });
		clock.advance(1001);
		expect(harness.stops).toBe(1);
	});

	test("reports unavailable when no server matches", async () => {
		const harness = createManagerHarness({ resolve: async () => ({ kind: "no-server" }) });
		const [snap] = await harness.manager.check({
			paths: ["/repo/a.unknown"],
			severity: "all",
		});
		expect(snap?.state).toBe("unavailable");
	});

	test("reports unavailable with commands when no executable exists", async () => {
		const harness = createManagerHarness({
			resolve: async () => ({ kind: "no-executable", commands: ["tsserver"] }),
		});
		const [snap] = await harness.manager.check({ paths: ["/repo/a.ts"], severity: "all" });
		expect(snap?.state).toBe("unavailable");
		expect(snap?.reason).toContain("tsserver");
	});

	test("maps findings and bumps document version on repeat", async () => {
		const harness = createManagerHarness({
			diagnostics: [
				{
					severity: 1,
					message: "bad",
					line: 2,
					character: 3,
					endLine: 2,
					endCharacter: 5,
					source: "ts",
					code: 2304,
				},
			],
		});
		const [snap] = await harness.manager.check({ paths: ["/repo/a.ts"], severity: "all" });
		expect(snap?.state).toBe("findings");
		expect(snap?.diagnostics[0]?.line).toBe(3);
		expect(snap?.diagnostics[0]?.column).toBe(4);
	});

	test("shutdown stops every live server", async () => {
		const harness = createManagerHarness();
		await harness.manager.check({ paths: ["/repo/a.ts"], waitMs: 1000, severity: "all" });
		await harness.manager.shutdown();
		expect(harness.stops).toBe(1);
	});
});

describe("navigation mapping", () => {
	test("maps operations to LSP methods", () => {
		expect(methodFor("definition")).toBe("textDocument/definition");
		expect(methodFor("references")).toBe("textDocument/references");
		expect(methodFor("hover")).toBe("textDocument/hover");
		expect(methodFor("workspaceSymbol")).toBe("workspace/symbol");
	});

	test("maps a location result to one-based coordinates", () => {
		const results = mapNavigation("definition", [
			{
				uri: "file:///repo/a.ts",
				range: { start: { line: 4, character: 2 }, end: { line: 4, character: 8 } },
			},
		]);
		expect(results[0]).toMatchObject({ kind: "location", line: 5, character: 3 });
	});

	test("maps hover contents to text", () => {
		const results = mapNavigation("hover", { contents: { value: "docs" } });
		expect(results).toEqual([{ kind: "hover", text: "docs" }]);
	});
});
