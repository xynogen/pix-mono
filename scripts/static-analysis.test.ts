import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	formatStaticAnalysisFailure,
	runStaticAnalysis,
	STATIC_ANALYSIS_COMMANDS,
	type StaticAnalysisCommand,
	StaticAnalysisError,
} from "./static-analysis.ts";

const repoRoot = join(import.meta.dir, "..");

describe("pre-publish static analysis", () => {
	test("runs formatting, linting, type checks, dependency hygiene, and high-severity audit", () => {
		expect(STATIC_ANALYSIS_COMMANDS.map(({ argv }) => argv)).toEqual([
			["bun", "run", "ci"],
			["bun", "run", "typecheck"],
			["bun", "test", "scripts/deps.test.ts"],
			["bun", "scripts/package-smoke.ts"],
			["bun", "audit", "--audit-level=high"],
		]);
	});

	test("runs checks sequentially", async () => {
		const calls: StaticAnalysisCommand[] = [];
		await runStaticAnalysis(async (command) => {
			calls.push(command);
			return 0;
		});
		expect(calls).toEqual([...STATIC_ANALYSIS_COMMANDS]);
	});

	test("stops before later checks after a failure", async () => {
		const calls: StaticAnalysisCommand[] = [];
		const result = runStaticAnalysis(async (command) => {
			calls.push(command);
			return calls.length === 2 ? 1 : 0;
		});

		let failure: unknown;
		try {
			await result;
		} catch (error) {
			failure = error;
		}
		expect(failure).toEqual(
			expect.objectContaining({
				name: "StaticAnalysisError",
				check: "TypeScript typecheck",
				argv: ["bun", "run", "typecheck"],
				exitCode: 1,
			}),
		);
		expect(calls).toEqual([...STATIC_ANALYSIS_COMMANDS.slice(0, 2)]);
	});

	test("formats an actionable GitHub annotation and machine-readable payload", () => {
		const typecheck = STATIC_ANALYSIS_COMMANDS[1];
		if (!typecheck) throw new Error("Missing TypeScript static-analysis command");
		const error = new StaticAnalysisError(typecheck, 2);
		const output = formatStaticAnalysisFailure(error);

		expect(output).toContain(
			"::error title=Pre-publish static analysis failed::TypeScript typecheck failed (exit 2). Reproduce: bun run typecheck",
		);
		expect(output).toContain(
			'STATIC_ANALYSIS_FAILURE={"check":"TypeScript typecheck","command":["bun","run","typecheck"],"exitCode":2,"rerun":"bun run typecheck"}',
		);
	});

	test("publish-all invokes version and static-analysis gates before registry access", () => {
		const source = readFileSync(join(repoRoot, "scripts", "publish-all.ts"), "utf8");
		const versionGate = source.indexOf('spawn(["bun", "scripts/check-versions.ts"]');
		const staticGate = source.indexOf("await runStaticAnalysis()");
		const registry = source.indexOf("fetch(`https://registry.npmjs.org/");

		expect(versionGate).toBeGreaterThan(-1);
		expect(staticGate).toBeGreaterThan(versionGate);
		expect(registry).toBeGreaterThan(staticGate);
	});

	test("CI uses the same agent-readable gate", () => {
		const workflow = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
		expect(workflow).toContain("run: bun run static-analysis");
		expect(workflow).toContain("run: bun run test");
	});
});
