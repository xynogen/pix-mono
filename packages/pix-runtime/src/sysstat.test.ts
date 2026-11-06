import { expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import si from "systeminformation";
import * as exec from "./exec.ts";
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
	const directories = spyOn(fs, "readdir").mockResolvedValue([] as never);
	const files = spyOn(fs, "readFile").mockResolvedValue("");
	const nvidia = spyOn(exec, "runTool").mockResolvedValue({
		code: 0,
		stdout: "0\n",
		timedOut: false,
		truncated: false,
	} as never);
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
		expect(nvidia).toHaveBeenCalledTimes(0);
		if (process.platform === "win32" || process.platform === "linux") {
			graphics.mockResolvedValue({
				controllers: [{ vendor: "NVIDIA", temperatureGpu: 40 }],
			} as never);
			expect(await readSystemStats()).toMatchObject({ gpu: 0, gpuTemp: 40 });
			expect(nvidia).toHaveBeenCalledWith(
				"nvidia-smi",
				["--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"],
				{ timeoutMs: 2_000, maxBuffer: 4096 },
			);
			for (const stdout of ["0\n35\n", "N/A\n0\n"]) {
				nvidia.mockResolvedValue({ code: 0, stdout } as never);
				expect(await readSystemStats()).toMatchObject({ gpu: stdout.includes("35") ? 35 : 0 });
			}
			for (const result of [
				{ code: 0, stdout: "" },
				{ code: 0, stdout: "N/A\n-1\n101\n" },
				{ code: 1, stdout: "0" },
				{ code: 0, stdout: "0", timedOut: true },
				{ code: 0, stdout: "0", truncated: true },
			]) {
				nvidia.mockResolvedValue(result as never);
				expect(await readSystemStats()).toMatchObject({ gpu: undefined, gpuTemp: 40 });
			}
			nvidia.mockRejectedValue(new Error("nvidia-smi unavailable"));
			expect(await readSystemStats()).toMatchObject({ gpu: undefined, gpuTemp: 40 });
		}
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
		if (process.platform === "linux") {
			directories.mockImplementation((async (path: unknown) =>
				String(path) === "/sys/class/drm"
					? ["card1", "card1-DP-1", "renderD128", "card2"]
					: ["hwmon5"]) as never);
			const sensors: Record<string, string> = {
				"/sys/class/drm/card1/device/vendor": "0x1002\n",
				"/sys/class/drm/card1/device/gpu_busy_percent": "45\n",
				"/sys/class/drm/card1/device/hwmon/hwmon5/temp1_input": "51000\n",
				"/sys/class/drm/card2/device/vendor": "0x10de\n",
			};
			files.mockImplementation((async (path: unknown) => {
				const value = sensors[String(path)];
				if (value === undefined) throw new Error("sensor unavailable");
				return value;
			}) as never);
			expect(await readSystemStats()).toEqual({
				cpu: undefined,
				cpuTemp: undefined,
				gpu: 45,
				gpuTemp: 51,
				ram: 0,
			});
			graphics.mockResolvedValue({ controllers: [{ utilizationGpu: 0 }] } as never);
			expect(await readSystemStats()).toMatchObject({ gpu: 0, gpuTemp: 51 });
			sensors["/sys/class/drm/card1/device/gpu_busy_percent"] = "";
			sensors["/sys/class/drm/card1/device/hwmon/hwmon5/temp1_input"] = "-1000";
			graphics.mockResolvedValue({ controllers: [] } as never);
			expect(await readSystemStats()).toMatchObject({ gpu: undefined, gpuTemp: undefined });
			sensors["/sys/class/drm/card1/device/gpu_busy_percent"] = "101";
			sensors["/sys/class/drm/card1/device/hwmon/hwmon5/temp1_input"] = "garbage";
			expect(await readSystemStats()).toMatchObject({ gpu: undefined, gpuTemp: undefined });
			directories.mockRejectedValue(new Error("sysfs unavailable"));
			expect(await readSystemStats()).toMatchObject({ gpu: undefined, gpuTemp: undefined });
		}
	} finally {
		cpu.mockRestore();
		temperature.mockRestore();
		graphics.mockRestore();
		memory.mockRestore();
		directories.mockRestore();
		files.mockRestore();
		nvidia.mockRestore();
	}
});
