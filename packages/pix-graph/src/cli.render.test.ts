import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@xynogen/pix-runtime/paths";
import { semanticRow } from "../../../scripts/ui-capture.ts";

test("captures graph query and analysis CLI streams in process without a runner", async () => {
	const root = mkdtempSync(join(tempDir(), "pix-graph-cli-capture-"));
	const graphPath = join(root, "graph.json");
	const argv = process.argv;
	const exitCode = process.exitCode;
	let output = "";
	let errors = "";
	const stdout = spyOn(process.stdout, "write").mockImplementation((chunk) => {
		output += String(chunk);
		return true;
	});
	const stderr = spyOn(console, "error").mockImplementation((message) => {
		errors += `${message}\n`;
	});
	try {
		writeFileSync(
			graphPath,
			JSON.stringify({
				nodes: [
					{ id: "auth", label: "authenticate", source_file: "src/auth.ts", type: "function" },
					{ id: "token", label: "loadToken", source_file: "src/token.ts", type: "function" },
					{ id: "cache", label: "cache", source_file: "src/cache.ts", type: "variable" },
				],
				links: [
					{ source: "auth", target: "token", relation: "calls" },
					{ source: "token", target: "cache", relation: "reads" },
				],
			}),
		);
		const captures: Record<string, { stdout: string; stderr: string; code: number }> = {};
		for (const [name, args] of Object.entries({
			bfs: ["query", "authenticate", "--graph", graphPath],
			dfs: ["query", "authenticate", "--graph", graphPath, "--dfs"],
			empty: ["query", "unmatched", "--graph", graphPath],
			path: ["path", "authenticate", "cache", "--graph", graphPath],
			invalid: ["query"],
			analysis: ["--graph", graphPath, "--out", root, "--root", root],
		})) {
			output = "";
			errors = "";
			process.exitCode = 0;
			process.argv = [process.execPath, "pix-graph", ...args];
			// ponytail: fresh CLI modules only. No subprocess, build, browser, or production mocking seam.
			await import(`${name === "analysis" ? "./analyze-graph.ts" : "./cli.ts"}?capture=${name}`);
			captures[name] = {
				stdout: output.replaceAll(root, "<fixture>").split("\n").map(semanticRow).join("\n"),
				stderr: errors.split("\n").map(semanticRow).join("\n"),
				code: Number(process.exitCode),
			};
			expect(process.exitCode).toBe(name === "invalid" ? 1 : 0);
		}
		expect(JSON.parse(readFileSync(join(root, "graph.cleaned.json"), "utf8")).nodes).toHaveLength(
			3,
		);
		expect(captures).toMatchSnapshot();
	} finally {
		stdout.mockRestore();
		stderr.mockRestore();
		process.argv = argv;
		process.exitCode = exitCode;
		rmSync(root, { recursive: true, force: true });
	}
});
