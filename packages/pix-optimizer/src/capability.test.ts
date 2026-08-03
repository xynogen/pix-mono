import { describe, expect, it, mock } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { canExecute } from "./capability.ts";

function executor(impl: ExtensionAPI["exec"]): Pick<ExtensionAPI, "exec"> {
	return { exec: impl };
}

describe("canExecute", () => {
	it("runs the requested capability probe without a shell", async () => {
		const exec = mock(async () => ({
			stdout: "jq-1.7",
			stderr: "",
			code: 0,
			killed: false,
		}));

		expect(await canExecute(executor(exec), "jq", ["--version"])).toBe(true);
		expect(exec).toHaveBeenCalledWith("jq", ["--version"], { timeout: 3000 });
	});

	it("supports a custom timeout", async () => {
		const exec = mock(async () => ({ stdout: "rtk 0.30.0", stderr: "", code: 0, killed: false }));

		expect(await canExecute(executor(exec), "rtk", ["--version"], 1000)).toBe(true);
		expect(exec).toHaveBeenCalledWith("rtk", ["--version"], { timeout: 1000 });
	});

	it("returns false for a non-zero exit", async () => {
		const exec = mock(async () => ({ stdout: "", stderr: "failed", code: 1, killed: false }));

		expect(await canExecute(executor(exec), "jq", ["--version"])).toBe(false);
	});

	it("returns false when the executable cannot be spawned", async () => {
		const exec = mock(async () => {
			throw new Error("ENOENT");
		});

		expect(await canExecute(executor(exec), "rtk", ["--version"])).toBe(false);
	});
});
