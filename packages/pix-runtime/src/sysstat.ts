import { promises as fs } from "node:fs";
import si from "systeminformation";

export interface SystemStats {
	cpu?: number;
	cpuTemp?: number;
	gpu?: number;
	gpuTemp?: number;
	ram?: number;
}

/** Missing sensors, sentinel values and failed probes stay unavailable, never become zero. */
const reading = (value: unknown, max: number): number | undefined =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max
		? Math.round(value)
		: undefined;

async function readAmdStats(): Promise<SystemStats> {
	const stats: SystemStats = {};
	const read = (path: string) => fs.readFile(path, "utf8").catch(() => "");
	const cards = await fs.readdir("/sys/class/drm").catch(() => []);
	for (const card of cards.filter((name) => /^card\d+$/.test(name))) {
		const device = `/sys/class/drm/${card}/device`;
		if ((await read(`${device}/vendor`)).trim() !== "0x1002") continue;
		const busy = (await read(`${device}/gpu_busy_percent`)).trim();
		const gpu = busy ? reading(Number(busy), 100) : undefined;
		if (gpu !== undefined) stats.gpu = Math.max(stats.gpu ?? 0, gpu);
		const sensors = await fs.readdir(`${device}/hwmon`).catch(() => []);
		for (const sensor of sensors) {
			const raw = (await read(`${device}/hwmon/${sensor}/temp1_input`)).trim();
			const temperature = raw ? reading(Number(raw) / 1000, 150) : undefined;
			if (temperature !== undefined) stats.gpuTemp = Math.max(stats.gpuTemp ?? 0, temperature);
		}
	}
	return stats;
}

/** Read each source independently so an unsupported sensor cannot discard other readings. */
export async function readSystemStats(): Promise<SystemStats> {
	const [cpu, temperature, graphics, memory] = await Promise.allSettled([
		si.currentLoad(),
		si.cpuTemperature(),
		si.graphics(),
		si.mem(),
	]);
	const controllers = graphics.status === "fulfilled" ? graphics.value.controllers : [];
	const highest = (key: "utilizationGpu" | "temperatureGpu", max: number) => {
		const values = controllers
			.map((controller) => reading(controller[key], max))
			.filter((value): value is number => value !== undefined);
		return values.length ? Math.max(...values) : undefined;
	};
	const gpu = highest("utilizationGpu", 100);
	const gpuTemp = highest("temperatureGpu", 150);
	const amd =
		process.platform === "linux" && (gpu === undefined || gpuTemp === undefined)
			? await readAmdStats()
			: {};
	return {
		cpu: cpu.status === "fulfilled" ? reading(cpu.value.currentLoad, 100) : undefined,
		cpuTemp: temperature.status === "fulfilled" ? reading(temperature.value.main, 150) : undefined,
		gpu: gpu ?? amd.gpu,
		gpuTemp: gpuTemp ?? amd.gpuTemp,
		ram:
			memory.status === "fulfilled" && memory.value.total > 0
				? reading(((memory.value.total - memory.value.available) / memory.value.total) * 100, 100)
				: undefined,
	};
}
