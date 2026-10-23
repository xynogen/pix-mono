/**
 * P0 eval harness — runs fixed tasks through headless Pi and records token,
 * tool and pass metrics as JSON, so harness changes are measured, not guessed.
 *
 *   bun scripts/eval/run.ts [--model provider/id]... [--tasks id,id] [--repeat n]
 *                           [--thinking level] [--timeout sec] [--label name]
 *                           [--pix '{"compaction":{...}}'] [--compare before.json]
 *   bun scripts/eval/run.ts --compare before.json after.json
 *
 * Pi runs with the user's own settings and extensions (dev-link decides which
 * pix code is measured). Without --model, Pi's default model is used. --pix
 * overlays pix.json sections for this run only: Pi gets a temp agent dir that
 * links every other entry of the real one. Results go to
 * `.pi/eval/<stamp>-<label>.json`.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { runTool } from "@xynogen/pix-runtime/exec";
import { agentDir, projectDir, tempDir } from "@xynogen/pix-runtime/paths";
import { cacheRatio, collectMetrics, parseJsonl, type RunMetrics } from "./metrics.ts";
import { FIXTURE, TASKS } from "./tasks.ts";

interface TaskResult extends RunMetrics {
	task: string;
	kind: string;
	run: number;
	pass: boolean;
	timedOut: boolean;
	exitCode: number | null;
	durationMs: number;
}

interface EvalFile {
	label: string;
	date: string;
	/** pix.json overlay used for the run, if any. */
	pix?: string;
	commit: string;
	results: TaskResult[];
}

const root = join(import.meta.dir, "..", "..");

function writeFixture(dir: string, files: Record<string, string>): void {
	for (const [rel, text] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, rel)), { recursive: true });
		writeFileSync(join(dir, rel), text);
	}
}

/** Temp agent dir: the real one linked entry by entry, with `pix` merged into pix.json. */
function overlayAgentDir(pix: Record<string, Record<string, unknown>>): string {
	const real = agentDir();
	const dir = mkdtempSync(join(tempDir(), "pix-eval-agent-"));
	for (const name of readdirSync(real))
		if (name !== "pix.json") symlinkSync(join(real, name), join(dir, name));
	const base = existsSync(join(real, "pix.json"))
		? JSON.parse(readFileSync(join(real, "pix.json"), "utf8"))
		: {};
	for (const [section, values] of Object.entries(pix))
		base[section] = { ...(base[section] ?? {}), ...values };
	writeFileSync(join(dir, "pix.json"), `${JSON.stringify(base, null, "\t")}\n`);
	return dir;
}

async function testsPass(dir: string): Promise<boolean> {
	// The fixture's own tests, with the bun that runs this script.
	const proc = Bun.spawn([process.execPath, "test"], {
		cwd: dir,
		stdout: "ignore",
		stderr: "ignore",
	});
	return (await proc.exited) === 0;
}

async function runTask(
	task: (typeof TASKS)[number],
	run: number,
	opts: {
		model?: string;
		thinking?: string;
		timeoutMs: number;
		logDir: string;
		agentDir?: string;
	},
): Promise<TaskResult> {
	const dir = mkdtempSync(join(tempDir(), "pix-eval-"));
	try {
		writeFixture(dir, { ...FIXTURE, ...task.files });
		const args = ["--mode", "json", "--no-session", "--offline"];
		if (opts.model) args.push("--model", opts.model);
		if (opts.thinking) args.push("--thinking", opts.thinking);
		args.push("--", task.prompt, ...(task.followUps ?? []));
		const started = performance.now();
		const env = opts.agentDir ? { ...process.env, PI_CODING_AGENT_DIR: opts.agentDir } : undefined;
		const res = await runTool("pi", args, { cwd: dir, env, timeoutMs: opts.timeoutMs });
		const durationMs = Math.round(performance.now() - started);
		// Raw stream kept for inspection: what the agent read, ran and changed.
		writeFileSync(join(opts.logDir, `${task.id}-${run}.jsonl`), res.stdout);
		const metrics = collectMetrics(parseJsonl(res.stdout));
		let pass = false;
		try {
			pass = await task.check({
				dir,
				finalText: metrics.finalText,
				testsPass: () => testsPass(dir),
			});
		} catch {
			pass = false; // a check that throws (missing file, etc.) is a fail, not a crash
		}
		return {
			...metrics,
			task: task.id,
			kind: task.kind,
			run,
			pass,
			timedOut: res.timedOut,
			exitCode: res.code,
			durationMs,
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── Reporting ────────────────────────────────────────────────────────────────

interface Summary {
	runs: number;
	pass: number;
	input: number;
	output: number;
	cacheRead: number;
	toolCalls: number;
	editFailed: number;
	editStale: number;
	timedOut: number;
	runaway: number;
	providerErrors: number;
	cost: number;
}

function summarize(results: TaskResult[]): Map<string, Summary> {
	const out = new Map<string, Summary>();
	for (const r of results) {
		const key = r.model || "(unknown)";
		const s = out.get(key) ?? {
			runs: 0,
			pass: 0,
			input: 0,
			output: 0,
			cacheRead: 0,
			toolCalls: 0,
			editFailed: 0,
			editStale: 0,
			timedOut: 0,
			runaway: 0,
			providerErrors: 0,
			cost: 0,
		};
		s.runs++;
		s.pass += r.pass ? 1 : 0;
		s.input += r.input;
		s.output += r.output;
		s.cacheRead += r.cacheRead;
		s.toolCalls += r.toolCalls;
		s.editFailed += r.editFailed;
		s.editStale += r.editStale;
		s.timedOut += r.timedOut ? 1 : 0;
		s.runaway += r.runaway ? 1 : 0;
		s.providerErrors += r.providerErrors;
		s.cost += r.cost;
		out.set(key, s);
	}
	return out;
}

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
const avg = (n: number, runs: number) => (runs ? Math.round(n / runs) : 0);
const delta = (a: number, b: number) =>
	a ? `${b >= a ? "+" : ""}${(((b - a) / a) * 100).toFixed(1)}%` : "n/a";

function row(s: Summary): string[] {
	return [
		`${s.pass}/${s.runs}`,
		String(avg(s.input, s.runs)),
		String(avg(s.output, s.runs)),
		pct(cacheRatio(s)),
		(s.toolCalls / s.runs).toFixed(1),
		String(s.editFailed),
		String(s.editStale),
		String(s.timedOut),
		String(s.runaway),
		String(s.providerErrors),
		`$${s.cost.toFixed(4)}`,
	];
}

const HEAD = [
	"model",
	"pass",
	"in/run",
	"out/run",
	"cache",
	"tools/run",
	"editFail",
	"stale",
	"timeout",
	"cost",
];

function printTable(rows: string[][]): void {
	const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length))) ?? [];
	for (const r of rows) console.log(r.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  "));
}

function report(file: EvalFile, before?: EvalFile): void {
	const now = summarize(file.results);
	const rows = [HEAD];
	for (const [model, s] of now) rows.push([model, ...row(s)]);
	console.log(`\n${file.label} (${file.commit})`);
	printTable(rows);
	if (!before) return;
	const prev = summarize(before.results);
	const drows = [["model", "pass", "in/run", "out/run", "cache", "tools/run"]];
	for (const [model, b] of now) {
		const a = prev.get(model);
		if (!a) continue;
		drows.push([
			model,
			`${pct(a.pass / a.runs)} → ${pct(b.pass / b.runs)}`,
			delta(a.input / a.runs, b.input / b.runs),
			delta(a.output / a.runs, b.output / b.runs),
			`${pct(cacheRatio(a))} → ${pct(cacheRatio(b))}`,
			delta(a.toolCalls / a.runs, b.toolCalls / b.runs),
		]);
	}
	console.log(`\nvs ${before.label} (${before.commit})`);
	printTable(drows);
}

// ── Main ─────────────────────────────────────────────────────────────────────

const loadEval = (path: string): EvalFile => JSON.parse(readFileSync(path, "utf8"));

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			model: { type: "string", multiple: true },
			tasks: { type: "string" },
			repeat: { type: "string", default: "1" },
			thinking: { type: "string" },
			timeout: { type: "string", default: "300" },
			label: { type: "string", default: "run" },
			compare: { type: "string" },
			pix: { type: "string" },
		},
	});

	// Report-only: compare two saved runs without calling a model.
	if (values.compare && positionals[0]) {
		report(loadEval(positionals[0]), loadEval(values.compare));
		return;
	}

	const wanted = values.tasks?.split(",").map((s) => s.trim());
	const tasks = wanted ? TASKS.filter((t) => wanted.includes(t.id)) : TASKS;
	const unknown = wanted?.filter((id) => !TASKS.some((t) => t.id === id)) ?? [];
	if (unknown.length) throw new Error(`unknown task id(s): ${unknown.join(", ")}`);
	const repeat = Math.max(1, Number(values.repeat) || 1);
	const timeoutMs = Math.max(10, Number(values.timeout) || 300) * 1000;
	const models = values.model?.length ? values.model : [undefined];
	const overlay = values.pix ? overlayAgentDir(JSON.parse(values.pix)) : undefined;

	const commit = (
		await runTool("git", ["rev-parse", "--short", "HEAD"], { cwd: root })
	).stdout.trim();
	const file: EvalFile = {
		label: values.label,
		date: new Date().toISOString(),
		commit,
		pix: values.pix,
		results: [],
	};
	const stamp = file.date.replace(/[:.]/g, "-").slice(0, 19);
	const outDir = join(projectDir(root), "eval");
	const logRoot = join(outDir, `${stamp}-${values.label}`);
	for (const model of models) {
		for (const task of tasks) {
			for (let run = 1; run <= repeat; run++) {
				const logDir = join(logRoot, (model ?? "default").replace(/[^\w.-]+/g, "_"));
				mkdirSync(logDir, { recursive: true });
				const r = await runTask(task, run, {
					model,
					thinking: values.thinking,
					timeoutMs,
					logDir,
					agentDir: overlay,
				});
				file.results.push(r);
				const status = r.runaway
					? "RUNAWAY"
					: !r.pass && r.providerErrors
						? "PROVERR"
						: r.timedOut
							? "TIMEOUT"
							: r.pass
								? "pass"
								: "FAIL";
				console.log(
					`${status.padEnd(7)} ${task.id.padEnd(18)} ${r.model || model || "?"} · in ${r.input} · out ${r.output} · cache ${r.cacheRead} · tools ${r.toolCalls} · ${(r.durationMs / 1000).toFixed(0)}s`,
				);
			}
		}
	}

	if (overlay) rmSync(overlay, { recursive: true, force: true });
	const out = `${logRoot}.json`;
	writeFileSync(out, `${JSON.stringify(file, null, "\t")}\n`);
	console.log(`\nsaved ${out}`);
	report(file, values.compare ? loadEval(values.compare) : undefined);
}

await main();
