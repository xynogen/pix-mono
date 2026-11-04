/**
 * sysstat.ts — cheap host load sample for status bars: CPU %, RAM %, GPU %, CPU temperature.
 *
 * CPU and RAM come from `node:os`, so they work on every OS. GPU busy % and temperature
 * are read from Linux sysfs (`/sys/class/drm`, `/sys/class/hwmon`, `/sys/class/thermal`);
 * elsewhere, or when the driver exposes nothing, those fields are undefined.
 * ponytail: no NVIDIA support (its driver has no sysfs busy file). Add an `nvidia-smi`
 * catalog binary and a slow poll here if that is needed.
 */

import { readdirSync, readFileSync } from "node:fs";
import { cpus, freemem, totalmem } from "node:os";
import { join } from "node:path";

export interface SystemStats {
	/** Busy CPU since the previous sample, 0–100. Undefined on the first sample. */
	cpu?: number;
	/** Used memory (total − available), 0–100. */
	ram?: number;
	/** GPU busy, 0–100 (Linux amdgpu/i915/xe sysfs only). */
	gpu?: number;
	/** CPU package temperature in °C (Linux hwmon/thermal only). */
	temp?: number;
}

/** Opaque CPU counter snapshot; pass the previous one to get a CPU percent. */
export type CpuTimes = { busy: number; total: number };

export function cpuTimes(): CpuTimes {
	let busy = 0;
	let total = 0;
	for (const { times } of cpus()) {
		const sum = times.user + times.nice + times.sys + times.idle + times.irq;
		total += sum;
		busy += sum - times.idle;
	}
	return { busy, total };
}

/** Busy share between two snapshots, 0–100, or undefined when no time passed. */
export function cpuPercent(prev: CpuTimes, next: CpuTimes): number | undefined {
	const total = next.total - prev.total;
	if (total <= 0) return undefined;
	return clampPct(((next.busy - prev.busy) / total) * 100);
}

const clampPct = (n: number) => Math.min(100, Math.max(0, Math.round(n)));

function readNumber(path: string): number | undefined {
	try {
		const n = Number(readFileSync(path, "utf8").trim());
		return Number.isFinite(n) ? n : undefined;
	} catch {
		return undefined;
	}
}

function list(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

/** Highest `gpu_busy_percent` across DRM cards (a laptop may report an idle iGPU too). */
export function readGpuBusy(sys = "/sys"): number | undefined {
	let best: number | undefined;
	for (const card of list(join(sys, "class/drm"))) {
		if (!/^card\d+$/.test(card)) continue;
		const n = readNumber(join(sys, "class/drm", card, "device/gpu_busy_percent"));
		if (n !== undefined) best = Math.max(best ?? 0, clampPct(n));
	}
	return best;
}

// CPU sensor drivers, most specific first. coretemp = Intel, k10temp/zenpower = AMD.
const CPU_HWMON = ["k10temp", "zenpower", "coretemp", "cpu_thermal", "acpitz"];

/** CPU temperature in °C from hwmon (known CPU drivers), then thermal_zone0. */
export function readCpuTemp(sys = "/sys"): number | undefined {
	const hwmon = join(sys, "class/hwmon");
	const byName = new Map<string, string>();
	for (const dir of list(hwmon)) {
		try {
			byName.set(readFileSync(join(hwmon, dir, "name"), "utf8").trim(), dir);
		} catch {}
	}
	for (const name of CPU_HWMON) {
		const dir = byName.get(name);
		const milli = dir && readNumber(join(hwmon, dir, "temp1_input"));
		if (milli) return Math.round(milli / 1000);
	}
	const zone = readNumber(join(sys, "class/thermal/thermal_zone0/temp"));
	return zone ? Math.round(zone / 1000) : undefined;
}

/**
 * Take one sample. Keep the returned `times` and pass it back next call so CPU % covers
 * the interval between calls. Synchronous and cheap (a few small sysfs reads).
 */
export function readSystemStats(
	prev?: CpuTimes,
	sys = "/sys",
): { stats: SystemStats; times: CpuTimes } {
	const times = cpuTimes();
	const total = totalmem();
	const linux = process.platform === "linux";
	return {
		times,
		stats: {
			cpu: prev ? cpuPercent(prev, times) : undefined,
			ram: total > 0 ? clampPct(((total - freemem()) / total) * 100) : undefined,
			gpu: linux ? readGpuBusy(sys) : undefined,
			temp: linux ? readCpuTemp(sys) : undefined,
		},
	};
}
