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
	return {
		cpu: cpu.status === "fulfilled" ? reading(cpu.value.currentLoad, 100) : undefined,
		cpuTemp: temperature.status === "fulfilled" ? reading(temperature.value.main, 150) : undefined,
		gpu: highest("utilizationGpu", 100),
		gpuTemp: highest("temperatureGpu", 150),
		ram:
			memory.status === "fulfilled" && memory.value.total > 0
				? reading(((memory.value.total - memory.value.available) / memory.value.total) * 100, 100)
				: undefined,
	};
}
