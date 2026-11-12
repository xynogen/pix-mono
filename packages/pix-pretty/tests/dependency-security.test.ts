import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(packageRoot));

interface PackageManifest {
	dependencies?: Record<string, string>;
	overrides?: Record<string, string>;
}

function readManifest(path: string): PackageManifest {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
	} catch (cause) {
		throw new Error(`Unable to read package manifest: ${path}`, { cause });
	}
}

describe("dependency security floors", () => {
	it("uses a jsdiff release without GHSA-73rr-hh4g-fpgx", () => {
		const manifest = readManifest(join(packageRoot, "package.json"));
		expect(manifest.dependencies?.diff).toBe("^8.0.3");
	});

	it("pins protobufjs above GHSA-j3f2-48v5-ccww", () => {
		const manifest = readManifest(join(repoRoot, "package.json"));
		expect(manifest.overrides?.protobufjs).toBe("7.6.5");
	});
});
