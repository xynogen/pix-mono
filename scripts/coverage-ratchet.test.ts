import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("coverage gate preserves large failure logs and enforces coverage thresholds", async () => {
	const root = mkdtempSync(join(tmpdir(), "pix-coverage-ratchet-"));
	try {
		const source = await Bun.file(new URL("./coverage-ratchet.ts", import.meta.url)).text();
		const command = '["bun", "test", "--isolate", "--coverage", "--coverage-reporter=text"]';
		expect(source).toContain(command);
		for (const [exitCode, summary, expectedCode, expectedMessage] of [
			[1, "All files | 100 | 100 |", 1, "Tests failed (exit 1); coverage not checked."],
			[0, "All files | 83 | 84 |", 0, "Coverage ratchet passed."],
			[0, "All files | 82.9 | 90 |", 1, "Coverage below threshold:"],
			[0, "All files | 90 | 83.9 |", 1, "Coverage below threshold:"],
			[0, "no summary", 1, "Coverage: could not find 'All files' summary"],
		] as const) {
			const fixture = `import { writeSync } from "node:fs";
writeSync(1, "o".repeat(1_000_000) + "\\nstdout-end\\n");
writeSync(2, "e".repeat(1_000_000) + "\\nstderr-end\\n" + ${JSON.stringify(summary)} + "\\n");
process.exit(${exitCode});`;
			const script = join(root, "coverage-ratchet.ts");
			await Bun.write(
				script,
				source.replace(command, JSON.stringify([process.execPath, "-e", fixture])),
			);
			const run = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
			const [out, err, code] = await Promise.all([
				new Response(run.stdout).text(),
				new Response(run.stderr).text(),
				run.exited,
			]);
			expect(code).toBe(expectedCode);
			const stdout = `${"o".repeat(1_000_000)}\nstdout-end\n`;
			const stderr = `${"e".repeat(1_000_000)}\nstderr-end\n${summary}\n`;
			expect(out.slice(0, stdout.length)).toBe(stdout);
			expect(err.slice(0, stderr.length)).toBe(stderr);
			expect(`${out}${err}`).toContain(expectedMessage);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
