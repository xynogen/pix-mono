import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let root = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pix-dev-link-"));
	mkdirSync(join(root, "scripts"), { recursive: true });
	writeFileSync(
		join(root, "scripts", "dev-link.sh"),
		readFileSync(join(import.meta.dir, "dev-link.sh")),
	);
	chmodSync(join(root, "scripts", "dev-link.sh"), 0o755);

	for (const [name, dependencies] of [
		["pix-app", { "@xynogen/pix-lib": "^1.0.0", maria2: "^0.4.1" }],
		["pix-lib", { "@xynogen/pix-leaf": "^1.0.0" }],
		["pix-leaf", {}],
	] as const) {
		const dir = join(root, "packages", name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({
				name: `@xynogen/${name}`,
				version: "1.0.0",
				dependencies,
				...(name === "pix-app" ? { pi: { extensions: ["./index.ts"] } } : {}),
			}),
		);
	}

	mkdirSync(join(root, "pi"), { recursive: true });
	mkdirSync(join(root, "home", ".pi", "agent"), { recursive: true });
	writeFileSync(join(root, "home", ".pi", "agent", "settings.json"), '{"packages":[]}\n');

	const bin = join(root, "bin");
	mkdirSync(bin);
	writeFileSync(
		join(bin, "bun"),
		`#!/usr/bin/env bash\nprintf '%s\\n' "$*" > "${join(root, "bun-args")}"\nmkdir -p "${join(root, "node_modules", "maria2", "dist")}"\ntouch "${join(root, "node_modules", "maria2", "dist", "index.js")}"\n`,
	);
	chmodSync(join(bin, "bun"), 0o755);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

// dev-link.sh is a bash script. In PowerShell on Windows, `bash` can be the WSL stub
// with no Linux installed, so skip unless a real bash runs.
const hasBash = spawnSync("bash", ["-c", "echo ok"], { encoding: "utf8" }).stdout?.trim() === "ok";

describe("dev-link", () => {
	test.skipIf(!hasBash)("discovers and registers pix-codemode from its manifest", () => {
		const dir = join(root, "packages", "pix-codemode");
		mkdirSync(dir);
		writeFileSync(join(dir, "package.json"), readFileSync(join(import.meta.dir, "..", "packages", "pix-codemode", "package.json")));
		const result = spawnSync("bash", [join(root, "scripts", "dev-link.sh"), "pix-codemode"], {
			cwd: root,
			env: { ...process.env, HOME: join(root, "home"), PI_NPM_DIR: join(root, "pi"), PATH: `${join(root, "bin")}:${process.env.PATH}` },
			encoding: "utf8",
		});
		expect(result.status).toBe(0);
		expect(readlinkSync(join(root, "pi", "node_modules", "@xynogen", "pix-codemode"))).toBe(dir);
		const settings = JSON.parse(readFileSync(join(root, "home", ".pi", "agent", "settings.json"), "utf8"));
		expect(settings.packages.map((p: string) => p.replaceAll("\\", "/"))).toEqual([dir.replaceAll("\\", "/")]);
	});
	test.skipIf(!hasBash)("installs workspace dependencies and links selected package dependency closure", () => {
		const result = spawnSync("bash", [join(root, "scripts", "dev-link.sh"), "pix-app"], {
			cwd: root,
			env: {
				...process.env,
				HOME: join(root, "home"),
				PI_NPM_DIR: join(root, "pi"),
				PATH: `${join(root, "bin")}:${process.env.PATH}`,
			},
			encoding: "utf8",
		});

		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		expect(readFileSync(join(root, "bun-args"), "utf8").trim()).toBe(
			"install --frozen-lockfile",
		);
		for (const name of ["pix-app", "pix-lib", "pix-leaf"]) {
			expect(readlinkSync(join(root, "pi", "node_modules", "@xynogen", name))).toBe(
				join(root, "packages", name),
			);
		}
		expect(existsSync(join(root, "node_modules", "maria2", "dist", "index.js"))).toBe(true);
		// dev-link.sh is bash, so it writes "/" paths on Windows too. Compare with one separator.
		const slash = (p: string) => p.replaceAll("\\", "/");
		expect(
			JSON.parse(
				readFileSync(join(root, "home", ".pi", "agent", "settings.json"), "utf8"),
			).packages.map(slash),
		).toEqual([slash(join(root, "packages", "pix-app"))]);
	});
});
