import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./paths.ts";
import { cpuPercent, readCpuTemp, readGpuBusy, readSystemStats } from "./sysstat.ts";

function fakeSys(files: Record<string, string>): string {
	const root = mkdtempSync(join(tempDir(), "sysstat-"));
	for (const [path, value] of Object.entries(files)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), value);
	}
	return root;
}

test("cpuPercent is the busy share of the elapsed interval", () => {
	expect(cpuPercent({ busy: 100, total: 400 }, { busy: 150, total: 500 })).toBe(50);
	expect(cpuPercent({ busy: 1, total: 1 }, { busy: 1, total: 1 })).toBeUndefined();
});

test("GPU busy takes the busiest DRM card and ignores connector entries", () => {
	const sys = fakeSys({
		"class/drm/card0/device/gpu_busy_percent": "3\n",
		"class/drm/card1/device/gpu_busy_percent": "49\n",
		"class/drm/card1-DP-1/status": "connected\n",
	});
	expect(readGpuBusy(sys)).toBe(49);
	expect(readGpuBusy(fakeSys({}))).toBeUndefined();
});

test("CPU temp prefers a CPU hwmon driver over other sensors, then thermal_zone0", () => {
	const sys = fakeSys({
		"class/hwmon/hwmon0/name": "nvme\n",
		"class/hwmon/hwmon0/temp1_input": "40000\n",
		"class/hwmon/hwmon1/name": "k10temp\n",
		"class/hwmon/hwmon1/temp1_input": "55625\n",
	});
	expect(readCpuTemp(sys)).toBe(56);
	expect(readCpuTemp(fakeSys({ "class/thermal/thermal_zone0/temp": "61000" }))).toBe(61);
	expect(readCpuTemp(fakeSys({}))).toBeUndefined();
});

test("a live sample stays inside 0–100 and CPU appears from the second sample", () => {
	const first = readSystemStats();
	expect(first.stats.cpu).toBeUndefined();
	const { stats } = readSystemStats(first.times);
	for (const pct of [stats.cpu, stats.ram, stats.gpu]) {
		if (pct !== undefined) expect(pct).toBeWithin(0, 101);
	}
	expect(stats.ram).toBeDefined();
});
