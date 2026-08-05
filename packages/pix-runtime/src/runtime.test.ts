import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { migrate } from "./migrations.ts";
import type { StorageAdapter } from "./persistence.ts";
import { createRuntime } from "./runtime.ts";
import { stripDefaults } from "./schema.ts";
import { collapseSection } from "./sections/collapse.ts";
import { compactionSection } from "./sections/compaction.ts";
import { gateSection } from "./sections/gate.ts";
import { ioSection } from "./sections/io.ts";
import { optimizerSection } from "./sections/optimizer.ts";
import { prettySection } from "./sections/pretty.ts";
import { createIsolatedRuntime, type IsolatedRuntime } from "./testing.ts";

let iso: IsolatedRuntime | null = null;
function fresh(): IsolatedRuntime {
	iso = createIsolatedRuntime();
	return iso;
}
afterEach(() => {
	iso?.cleanup();
	iso = null;
});

function readConfig(dir: string): Record<string, unknown> {
	const p = join(dir, "pix.json");
	return existsSync(p) ? (JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>) : {};
}

describe("schema and normalization", () => {
	it("resolves defaults for a missing file", () => {
		const { runtime } = fresh();
		expect(runtime.get(prettySection).icons).toBe("nerd");
		expect(runtime.get(collapseSection).enabled).toBe(true);
		expect(runtime.get(compactionSection).minimumTokens).toBe(100_000);
		expect(runtime.get(gateSection).guardrails).toBe("on");
		expect(runtime.get(ioSection).timeoutSec).toBe(30);
		expect(runtime.get(optimizerSection).rtk).toBe("on");
	});

	it("parses a positive network timeout and falls back for invalid values", async () => {
		const { runtime, agentDir } = fresh();
		writeFileSync(join(agentDir, "pix.json"), JSON.stringify({ io: { timeoutSec: 120 } }));
		await runtime.reload();
		expect(runtime.get(ioSection).timeoutSec).toBe(120);

		writeFileSync(join(agentDir, "pix.json"), JSON.stringify({ io: { timeoutSec: 0 } }));
		await runtime.reload();
		expect(runtime.get(ioSection).timeoutSec).toBe(30);
	});

	it("enforces a 25k minimum compaction floor", async () => {
		const { runtime, agentDir } = fresh();
		writeFileSync(
			join(agentDir, "pix.json"),
			JSON.stringify({ compaction: { minimumTokens: 300_000 } }),
		);
		await runtime.reload();
		expect(runtime.get(compactionSection).minimumTokens).toBe(300_000);

		// 30k is above the 25k floor — passes through untouched.
		writeFileSync(
			join(agentDir, "pix.json"),
			JSON.stringify({ compaction: { minimumTokens: 30_000 } }),
		);
		await runtime.reload();
		expect(runtime.get(compactionSection).minimumTokens).toBe(30_000);

		// Below the floor clamps up to 25k.
		writeFileSync(
			join(agentDir, "pix.json"),
			JSON.stringify({ compaction: { minimumTokens: 10_000 } }),
		);
		await runtime.reload();
		expect(runtime.get(compactionSection).minimumTokens).toBe(25_000);
	});

	it("ignores the removed gate.disableDefaults field", async () => {
		const { runtime, agentDir } = fresh();
		writeFileSync(join(agentDir, "pix.json"), JSON.stringify({ gate: { disableDefaults: true } }));
		await runtime.reload();
		expect(runtime.get(gateSection).guardrails).toBe("on");
	});

	it("falls back invalid fields individually and diagnoses bad gate regex", () => {
		const { runtime, agentDir } = fresh();
		writeFileSync(
			join(agentDir, "pix.json"),
			JSON.stringify({
				pretty: { icons: "bogus", maxRenderLines: -5 },
				gate: { extraRules: [{ pattern: "(" }, { pattern: "ok" }] },
			}),
		);
		runtime.reload();
		expect(runtime.get(prettySection).icons).toBe("nerd");
		expect(runtime.get(prettySection).maxRenderLines).toBe(150);
		expect(runtime.get(gateSection).extraRules).toHaveLength(1);
		expect(runtime.diagnostics().some((d) => d.code === "INVALID_VALUE")).toBe(true);
	});

	it("returns deeply frozen snapshots", () => {
		const { runtime } = fresh();
		const pretty = runtime.get(prettySection) as { icons: string };
		expect(() => {
			pretty.icons = "ascii";
		}).toThrow();
	});

	it("strips defaults recursively", () => {
		const section: Record<string, unknown> = {
			icons: "nerd",
			diff: { splitMinWidth: 150, splitMinCodeWidth: 99 },
		};
		const remaining = stripDefaults(section, prettySection.defaults as Record<string, unknown>);
		expect(remaining).toBeGreaterThan(0);
		expect(section).toEqual({ diff: { splitMinCodeWidth: 99 } });
	});
});

describe("persistence", () => {
	it("writes only non-default values and preserves unknown fields", async () => {
		const { runtime, agentDir } = fresh();
		writeFileSync(join(agentDir, "pix.json"), JSON.stringify({ future: { x: 1 } }));
		await runtime.init();
		await runtime.update(prettySection, { icons: "ascii" });
		const doc = readConfig(agentDir);
		expect(doc.$version).toBe(1);
		expect(doc.future).toEqual({ x: 1 });
		expect(doc.pretty).toEqual({ icons: "ascii" });
		expect(doc.collapse).toBeUndefined(); // all defaults → omitted
	});

	it("writes guardrails using its positive on/off representation", async () => {
		const { runtime, agentDir } = fresh();
		await runtime.update(gateSection, { guardrails: "off" });
		expect(readConfig(agentDir).gate).toEqual({ guardrails: "off" });
	});

	it("leaves no temp file after a successful write", async () => {
		const { runtime, agentDir } = fresh();
		await runtime.update(collapseSection, { delaySec: 30 });
		const p = join(agentDir, "pix.json");
		const dir = readFileSync(p, "utf-8");
		expect(dir).toContain("30");
		// no stray tmp files
		const { readdirSync } = await import("node:fs");
		expect(readdirSync(agentDir).some((f) => f.includes(".tmp-"))).toBe(false);
	});

	it("no-op updates neither write nor emit", async () => {
		const { runtime } = fresh();
		const change = await runtime.update(prettySection, { icons: "nerd" });
		expect(change).toBeUndefined();
	});

	it("functional updater sees the latest on-disk value", async () => {
		const { runtime, agentDir } = fresh();
		writeFileSync(join(agentDir, "pix.json"), JSON.stringify({ collapse: { delaySec: 20 } }));
		const change = await runtime.update(collapseSection, (c) => ({
			...c,
			delaySec: c.delaySec + 5,
		}));
		expect(change?.current.get(collapseSection).delaySec).toBe(25);
	});

	it("preserves the snapshot when a write fails", async () => {
		const storage: StorageAdapter = {
			path: "/virtual/pix.json",
			readRaw: () => undefined,
			ensureDir: () => {},
			writeAtomic: () => {
				throw new Error("disk full");
			},
		};
		const runtime = createRuntime({ agentDir: "/virtual", storage });
		const change = await runtime.update(prettySection, { icons: "ascii" });
		expect(change).toBeUndefined();
		expect(runtime.get(prettySection).icons).toBe("nerd");
		expect(runtime.diagnostics().some((d) => d.code === "WRITE_FAILED")).toBe(true);
	});

	it("serializes concurrent updates without lost fields", async () => {
		const { runtime, agentDir } = fresh();
		await Promise.all([
			runtime.update(prettySection, { icons: "ascii" }),
			runtime.update(collapseSection, { delaySec: 30 }),
			runtime.update(optimizerSection, { caveman: "lite" }),
		]);
		const doc = readConfig(agentDir);
		expect((doc.pretty as { icons: string }).icons).toBe("ascii");
		expect((doc.collapse as { delaySec: number }).delaySec).toBe(30);
		expect((doc.optimizer as { caveman: string }).caveman).toBe("lite");
	});
});

describe("migration", () => {
	it("adds $version and strips legacy color keys", () => {
		const { document, changed } = migrate(
			{ pretty: { icons: "ascii", theme: "x", diff: { bgAdd: "#000", splitMinWidth: 170 } } },
			{ diagnostic: () => {} },
		);
		expect(changed).toBe(true);
		expect(document.$version).toBe(1);
		const pretty = document.pretty as Record<string, unknown>;
		expect(pretty.theme).toBeUndefined();
		expect((pretty.diff as Record<string, unknown>).bgAdd).toBeUndefined();
		expect((pretty.diff as Record<string, unknown>).splitMinWidth).toBe(170);
	});

	it("removes legacy optimizer TOON state", () => {
		const { document, changed } = migrate(
			{ $version: 1, optimizer: { caveman: "lite", toon: "on", rtk: "on" } },
			{ diagnostic: () => {} },
		);

		expect(changed).toBe(true);
		expect(document.optimizer).toEqual({ caveman: "lite", rtk: "on" });
	});

	it("imports optimizer.json once and archives it", async () => {
		const { runtime, agentDir } = fresh();
		writeFileSync(
			join(agentDir, "optimizer.json"),
			JSON.stringify({ caveman: "ultra", rtk: "off" }),
		);
		await runtime.init();
		expect(runtime.get(optimizerSection).caveman).toBe("ultra");
		expect(runtime.get(optimizerSection).rtk).toBe("off");
		expect(existsSync(join(agentDir, "optimizer.json"))).toBe(false);
		expect(existsSync(join(agentDir, "optimizer.json.migrated-v1"))).toBe(true);
	});

	it("archives a legacy sidecar containing only TOON state", async () => {
		const { runtime, agentDir } = fresh();
		writeFileSync(join(agentDir, "pix.json"), JSON.stringify({ $version: 1 }));
		writeFileSync(join(agentDir, "optimizer.json"), JSON.stringify({ toon: "on" }));

		await runtime.init();

		expect(existsSync(join(agentDir, "optimizer.json"))).toBe(false);
		expect(existsSync(join(agentDir, "optimizer.json.migrated-v1"))).toBe(true);
		expect(runtime.get(optimizerSection)).toEqual({
			caveman: "off",
			rtk: "on",
			ponytail: "off",
		});
	});

	it("canonical optimizer value wins a sidecar conflict", async () => {
		const { runtime, agentDir } = fresh();
		writeFileSync(join(agentDir, "pix.json"), JSON.stringify({ optimizer: { caveman: "lite" } }));
		writeFileSync(join(agentDir, "optimizer.json"), JSON.stringify({ caveman: "ultra" }));
		await runtime.init();
		expect(runtime.get(optimizerSection).caveman).toBe("lite");
	});

	it("enters read-only mode for a future version", async () => {
		const { runtime, agentDir } = fresh();
		writeFileSync(join(agentDir, "pix.json"), JSON.stringify({ $version: 999 }));
		await runtime.init();
		const change = await runtime.update(prettySection, { icons: "ascii" });
		expect(change).toBeUndefined();
		expect(runtime.diagnostics().some((d) => d.code === "UNSUPPORTED_CONFIG_VERSION")).toBe(true);
	});
});

describe("events and lifecycle", () => {
	it("emits changed paths and current snapshot", async () => {
		const { runtime } = fresh();
		const seen: string[][] = [];
		runtime.subscribe((c) => seen.push([...c.changed]));
		await runtime.update(prettySection, { icons: "ascii" });
		expect(seen).toEqual([["pretty.icons"]]);
	});

	it("respects path filters", async () => {
		const { runtime } = fresh();
		let hits = 0;
		runtime.subscribe(() => hits++, { paths: ["optimizer.*"] });
		await runtime.update(prettySection, { icons: "ascii" });
		expect(hits).toBe(0);
		await runtime.update(optimizerSection, { caveman: "lite" });
		expect(hits).toBe(1);
	});

	it("delivers an immediate snapshot to new subscribers", () => {
		const { runtime } = fresh();
		let got: string | undefined;
		runtime.subscribe(
			(c) => {
				got = c.current.get(prettySection).icons;
			},
			{ immediate: true },
		);
		expect(got).toBe("nerd");
	});

	it("isolates listener errors", async () => {
		const { runtime } = fresh();
		runtime.subscribe(() => {
			throw new Error("boom");
		});
		let ok = false;
		runtime.subscribe(() => {
			ok = true;
		});
		await runtime.update(prettySection, { icons: "ascii" });
		expect(ok).toBe(true);
		expect(runtime.diagnostics().some((d) => d.code === "LISTENER_FAILED")).toBe(true);
	});

	it("init is single-flight and idempotent", async () => {
		const { runtime } = fresh();
		const [a, b] = await Promise.all([runtime.init(), runtime.init()]);
		expect(a).toBe(b);
	});

	it("reset restores defaults", async () => {
		const { runtime } = fresh();
		await runtime.update(prettySection, { icons: "ascii" });
		await runtime.reset(prettySection);
		expect(runtime.get(prettySection).icons).toBe("nerd");
	});
});
