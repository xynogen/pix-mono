import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { projectDir, tempDir } from "@xynogen/pix-runtime/paths";
import { createManager } from "./manager.ts";
import { createResolver, loadProjectServers, rootForFile } from "./server-registry.ts";

// Compare resolved paths: on Windows the code walks drive-letter paths, not /repo/...
const access = async (path: string) => path === resolve("/repo/package.json");

function project(config?: unknown): string {
	const cwd = mkdtempSync(join(tempDir(), "pix-lsp-"));
	if (config !== undefined) {
		mkdirSync(projectDir(cwd));
		writeFileSync(join(projectDir(cwd), "lsp.json"), JSON.stringify(config));
	}
	return cwd;
}

const pythonConfig = {
	servers: {
		python: {
			command: "pyright-langserver",
			args: ["--stdio"],
			extensions: [".py", ".pyi"],
			languageId: "python",
			rootMarkers: ["pyproject.toml", ".git"],
		},
	},
};

describe("project LSP configuration", () => {
	test("has no built-in server choices", () => {
		const cwd = project();
		expect(loadProjectServers(cwd)).toEqual([]);
		expect(createResolver(cwd).specFor(join(cwd, "main.py"))).toBeUndefined();
	});

	test("loads the server selected by the project", () => {
		const cwd = project(pythonConfig);
		const spec = createResolver(cwd).specFor(join(cwd, "main.py"));
		expect(spec?.id).toBe("python");
		expect(spec?.commands).toEqual(["pyright-langserver"]);
		expect(spec?.args).toEqual(["--stdio"]);
		expect(spec?.languageId("main.py")).toBe("python");
	});

	test("ignores invalid project configuration", () => {
		const cwd = project({ servers: { python: { command: 42 } } });
		expect(loadProjectServers(cwd)).toEqual([]);
	});

	test("an existing manager picks up configuration added after an unavailable check", async () => {
		const cwd = project();
		const manager = createManager(cwd);
		const request = { paths: [join(cwd, "main.py")], severity: "all" as const };
		try {
			const [before] = await manager.check(request);
			expect(before).toMatchObject({
				state: "unavailable",
				reason: expect.stringContaining(".pi/lsp.json"),
			});
			mkdirSync(projectDir(cwd));
			writeFileSync(
				join(projectDir(cwd), "lsp.json"),
				JSON.stringify({
					servers: {
						python: { ...pythonConfig.servers.python, command: "pix-test-missing-python-server" },
					},
				}),
			);
			const [after] = await manager.check(request);
			expect(after).toMatchObject({
				state: "unavailable",
				reason: expect.stringContaining("pix-test-missing-python-server"),
			});
		} finally {
			await manager.shutdown();
		}
	});

	test("uses the nearest root marker", async () => {
		expect(await rootForFile("/repo/src/a.ts", ["package.json"], access)).toBe(resolve("/repo"));
	});
});
