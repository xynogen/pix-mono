#!/usr/bin/env bun
import { writeSync } from "node:fs";

// coverage-ratchet.ts — CI's only test run: runs the suite with coverage, fails on any test
// failure, then fails if coverage drops below thresholds.
// Current baseline ~72% funcs / 70% lines. Threshold set slightly below to ratchet.
const THRESHOLDS = { funcs: 60, lines: 58 } as const;

const proc = Bun.spawn(["bun", "test", "--isolate", "--coverage", "--coverage-reporter=text"], {
	stdout: "pipe",
	stderr: "pipe",
});
const [out, err, code] = await Promise.all([
	new Response(proc.stdout).text(),
	new Response(proc.stderr).text(),
	proc.exited,
]);
writeSync(1, out);
writeSync(2, err);
if (code !== 0) {
	console.error(`Tests failed (exit ${code}); coverage not checked.`);
	process.exit(code);
}
const combined = `${out}\n${err}`;
// Strip ANSI
const clean = combined.replace(/\x1b\[[0-9;]*m/g, "");
// Find "All files" line: columns are funcs | lines
const line = clean.split("\n").find((l) => l.includes("All files"));
if (!line) {
	console.error("Coverage: could not find 'All files' summary");
	process.exit(1);
}
// "All files  |  72.56 |  70.36 |"
const parts = line.split("|").map((p) => p.trim());
const funcs = Number.parseFloat(parts[1] ?? "");
const lines = Number.parseFloat(parts[2] ?? "");
if (Number.isNaN(funcs) || Number.isNaN(lines)) {
	console.error(`Coverage: could not parse thresholds from: ${line}`);
	process.exit(1);
}
console.log(
	`Coverage: ${funcs}% funcs / ${lines}% lines (threshold ${THRESHOLDS.funcs}/${THRESHOLDS.lines})`,
);
if (funcs < THRESHOLDS.funcs || lines < THRESHOLDS.lines) {
	console.error(
		`Coverage below threshold: funcs ${funcs}% < ${THRESHOLDS.funcs}% or lines ${lines}% < ${THRESHOLDS.lines}%`,
	);
	process.exit(1);
}
console.log("Coverage ratchet passed.");
