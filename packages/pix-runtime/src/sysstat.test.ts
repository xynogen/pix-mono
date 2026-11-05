import { expect, spyOn, test } from "bun:test";
import si from "systeminformation";
import { readSystemStats } from "./sysstat.ts";

test("systeminformation keeps five readings separate and rejects unavailable values", async () => {
	const cpu = spyOn(si, "currentLoad").mockResolvedValue({ currentLoad: 12.4 } as never);
	const temperature = spyOn(si, "cpuTemperature").mockResolvedValue({ main: 56.2 } as never);
	const graphics = spyOn(si, "graphics").mockResolvedValue({
		controllers: [
			{ utilizationGpu: 0, temperatureGpu: 40 },
			{ utilizationGpu: 84.6, temperatureGpu: 67.7 },
			{ utilizationGpu: null, temperatureGpu: -1 },
		],
	} as never);
	const memory = spyOn(si, "mem").mockResolvedValue({ total: 1000, available: 420 } as never);
	try {
		expect(await readSystemStats()).toEqual({
			cpu: 12,
			cpuTemp: 56,
			gpu: 85,
			gpuTemp: 68,
			ram: 58,
		});
		temperature.mockResolvedValue({ main: -1 } as never);
		graphics.mockResolvedValue({
			controllers: [{ utilizationGpu: 0, temperatureGpu: 50 }],
		} as never);
		expect(await readSystemStats()).toEqual({
			cpu: 12,
			cpuTemp: undefined,
			gpu: 0,
			gpuTemp: 50,
			ram: 58,
		});
		cpu.mockResolvedValue({ currentLoad: NaN } as never);
		temperature.mockResolvedValue({ main: Infinity } as never);
		graphics.mockResolvedValue({
			controllers: [{ utilizationGpu: 101, temperatureGpu: "60" }],
		} as never);
		memory.mockResolvedValue({ total: 0, available: 0 } as never);
		expect(await readSystemStats()).toEqual({
			cpu: undefined,
			cpuTemp: undefined,
			gpu: undefined,
			gpuTemp: undefined,
			ram: undefined,
		});
		cpu.mockRejectedValue(new Error("CPU unavailable"));
		temperature.mockRejectedValue(new Error("sensor unavailable"));
		graphics.mockRejectedValue(new Error("driver unavailable"));
		memory.mockResolvedValue({ total: 1000, available: 1000 } as never);
		expect(await readSystemStats()).toEqual({
			cpu: undefined,
			cpuTemp: undefined,
			gpu: undefined,
			gpuTemp: undefined,
			ram: 0,
		});
	} finally {
		cpu.mockRestore();
		temperature.mockRestore();
		graphics.mockRestore();
		memory.mockRestore();
	}
});
